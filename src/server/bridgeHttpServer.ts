import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BridgeError } from "../core/errors";
import { isAuthorizedBearerHeader } from "../core/auth";
import {
  bufferBoundedTransportResponse,
  writeBufferedResponse
} from "../core/boundedResponse";
import type { BridgeLogger } from "../core/logging";
import { McpSessionRouter } from "./mcpSessionRouter";

const LOOPBACK_HOST = "127.0.0.1";

export interface BridgeHttpServerOptions {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly getAccessToken: () => Promise<string>;
  readonly logger: BridgeLogger;
}

export class BridgeHttpServer {
  private server: Server | undefined;
  private router: McpSessionRouter | undefined;
  private endpointValue: string | undefined;

  public constructor(private readonly options: BridgeHttpServerOptions) {}

  public get endpoint(): string | undefined {
    return this.endpointValue;
  }

  public async start(): Promise<string> {
    if (this.server !== undefined) {
      throw new BridgeError("server-start-failed", "The MCP server is already running.");
    }
    if (this.options.host !== LOOPBACK_HOST) {
      throw new BridgeError("server-start-failed", "Only the IPv4 loopback host is supported.");
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.keepAliveTimeout = 5_000;

    try {
      await listen(server, this.options.port);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The server did not return a TCP address.");
      }
      const endpoint = `http://${LOOPBACK_HOST}:${address.port}/mcp`;
      this.router = new McpSessionRouter(
        [`${LOOPBACK_HOST}:${address.port}`, LOOPBACK_HOST],
        this.options.logger
      );
      this.server = server;
      this.endpointValue = endpoint;
      return endpoint;
    } catch (error) {
      server.close();
      throw new BridgeError("server-start-failed", "Failed to start the MCP server.", undefined, {
        cause: error
      });
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    const router = this.router;
    this.server = undefined;
    this.router = undefined;
    this.endpointValue = undefined;
    await router?.close();
    if (server !== undefined) {
      await closeServer(server);
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.url !== "/mcp") {
        sendJsonRpcError(response, 404, -32601, "MCP endpoint not found.", null);
        return;
      }
      if (request.method === "GET") {
        response.setHeader("allow", "POST, DELETE");
        sendJsonRpcError(response, 405, -32600, "Method not allowed.", null);
        return;
      }
      if (request.method !== "POST" && request.method !== "DELETE") {
        response.setHeader("allow", "POST, DELETE");
        sendJsonRpcError(response, 405, -32600, "Method not allowed.", null);
        return;
      }

      const expectedToken = await this.options.getAccessToken();
      if (!isAuthorizedBearerHeader(request.headers.authorization, expectedToken)) {
        response.setHeader("www-authenticate", "Bearer");
        sendJsonRpcError(
          response,
          401,
          -32001,
          "Authentication failed.",
          null,
          "authentication-failed"
        );
        return;
      }

      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      const requestId = readRequestId(body);
      const webRequest = createWebRequest(request, body);
      const router = this.router;
      if (router === undefined) {
        throw new BridgeError("internal-error", "The MCP request router is unavailable.");
      }
      const webResponse = await router.handle(webRequest, body);
      const bounded = await bufferBoundedTransportResponse(webResponse, requestId);
      writeBufferedResponse(response, bounded);
    } catch (error) {
      this.options.logger.error("request-failed", {
        errorCode: error instanceof BridgeError ? error.code : "internal-error"
      });
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, -32603, "Internal server error.", null, "internal-error");
      } else {
        response.destroy();
      }
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new BridgeError("invalid-tool-input", "The request body is not valid JSON.", undefined, {
      cause: error
    });
  }
}

function createWebRequest(request: IncomingMessage, parsedBody: unknown): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const host = headers.get("host") ?? LOOPBACK_HOST;
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers
  };
  if (request.method === "POST") {
    init.body = JSON.stringify(parsedBody);
    init.duplex = "half";
  }
  return new Request(`http://${host}${request.url ?? "/mcp"}`, init);
}

function readRequestId(body: unknown): unknown {
  return typeof body === "object" && body !== null && "id" in body ? body.id : null;
}

function sendJsonRpcError(
  response: ServerResponse,
  status: number,
  rpcCode: number,
  message: string,
  id: unknown,
  bridgeCode?: string
): void {
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: rpcCode,
        message,
        ...(bridgeCode === undefined ? {} : { data: { code: bridgeCode } })
      },
      id: typeof id === "string" || typeof id === "number" ? id : null
    }),
    "utf8"
  );
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(body.byteLength));
  response.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

export function readTcpPort(address: string | AddressInfo | null): number | undefined {
  return address !== null && typeof address !== "string" ? address.port : undefined;
}
