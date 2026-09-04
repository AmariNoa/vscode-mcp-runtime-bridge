import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeLogger } from "../core/logging";

export type ConfigureMcpServer = (server: McpServer) => void;

interface Session {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

export class McpSessionRouter {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly allowedHosts: readonly string[],
    private readonly logger: BridgeLogger,
    private readonly configureServer?: ConfigureMcpServer
  ) {}

  public async handle(request: Request, parsedBody: unknown): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        return jsonRpcError(404, "Unknown MCP session.", null);
      }
      return session.transport.handleRequest(request, { parsedBody });
    }

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(400, "A valid MCP session is required.", readRequestId(parsedBody));
    }

    let initializedSessionId: string | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      allowedHosts: [...this.allowedHosts],
      enableDnsRebindingProtection: true,
      onsessioninitialized: (createdSessionId) => {
        initializedSessionId = createdSessionId;
      },
      onsessionclosed: (closedSessionId) => {
        this.sessions.delete(closedSessionId);
        this.logger.info("client-disconnected", { sessionId: closedSessionId });
      }
    });
    const server = createMcpServer(this.configureServer);
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(request, { parsedBody });
      if (initializedSessionId !== undefined) {
        this.sessions.set(initializedSessionId, { server, transport });
        this.logger.info("client-connected", { sessionId: initializedSessionId });
      } else {
        await server.close();
      }
      return response;
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(activeSessions.map(({ server }) => server.close()));
  }
}

function createMcpServer(configureServer?: ConfigureMcpServer): McpServer {
  const server = new McpServer(
    {
      name: "vscode-mcp-runtime-bridge",
      version: "0.1.0"
    },
    { capabilities: { tools: {} } }
  );
  if (configureServer === undefined) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  } else {
    configureServer(server);
  }
  return server;
}

function jsonRpcError(status: number, message: string, id: unknown): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: typeof id === "string" || typeof id === "number" ? id : null
    },
    { status }
  );
}

function readRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("id" in body)) {
    return null;
  }
  return body.id;
}
