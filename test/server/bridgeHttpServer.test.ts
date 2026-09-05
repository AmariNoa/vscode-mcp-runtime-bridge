import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { MAX_TRANSPORT_RESPONSE_BYTES } from "../../src/core/boundedResponse";
import { BridgeError } from "../../src/core/errors";
import { NULL_LOGGER } from "../../src/core/logging";
import { BridgeHttpServer } from "../../src/server/bridgeHttpServer";
import { registerVsCodeTools } from "../../src/vscode/registerTools";
import type { VsCodeEditService } from "../../src/vscode/editTools";
import type { VsCodeToolsService } from "../../src/vscode/workspaceTools";

const ACCESS_TOKEN = "integration_test_token";
const activeServers: BridgeHttpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(activeServers.splice(0).map((server) => server.stop()));
});

async function startServer(
  port = 0,
  configureMcpServer?: ConstructorParameters<typeof BridgeHttpServer>[0]["configureMcpServer"]
): Promise<BridgeHttpServer> {
  const server = new BridgeHttpServer({
    host: "127.0.0.1",
    port,
    getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    logger: NULL_LOGGER,
    configureMcpServer
  });
  activeServers.push(server);
  await server.start();
  return server;
}

function createClient(endpoint: string, token = ACCESS_TOKEN): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  return {
    client: new Client({ name: "bridge-test-client", version: "1.0.0" }),
    transport: new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  };
}

describe("BridgeHttpServer", () => {
  it("rejects an invalid token before MCP request handling", async () => {
    const server = await startServer();
    const response = await fetch(server.endpoint!, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong_token",
        "content-type": "application/json"
      },
      body: "not-json"
    });
    const body = (await response.json()) as { error: { data: { code: string } } };

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(body.error.data.code).toBe("authentication-failed");
  });

  it("maps authenticated malformed JSON to invalid-tool-input", async () => {
    const server = await startServer();
    const response = await fetch(server.endpoint!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: "not-json"
    });
    const body = (await response.json()) as { error: { data: { code: string } } };

    expect(response.status).toBe(400);
    expect(body.error.data.code).toBe("invalid-tool-input");
  });

  it("supports an authenticated Streamable HTTP MCP session", async () => {
    const server = await startServer();
    const { client, transport } = createClient(server.endpoint!);

    await client.connect(transport);
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    await transport.terminateSession();
    await client.close();
  });

  it("registers and calls the VS Code read-only tools", async () => {
    const service = {
      getWorkspaceInfo: () => ({ sessionId: "test-session", supportedEnvironment: true }),
      getCapabilities: () => ({ supportedEnvironment: true, extensions: {} }),
      getOpenDocuments: () => ({ documents: [] }),
      readDocument: () => Promise.resolve({ uri: "untitled:test", text: "draft" }),
      getDiagnostics: () => ({ diagnostics: [], count: 0, truncated: false })
    } as unknown as VsCodeToolsService;
    const editService = {
      applyEdit: () => Promise.resolve({ uri: "untitled:test", currentVersion: 2 })
    } as unknown as VsCodeEditService;
    const server = await startServer(0, (mcpServer) =>
      registerVsCodeTools(mcpServer, service, NULL_LOGGER, "test-session", editService)
    );
    const { client, transport } = createClient(server.endpoint!);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "vscode.apply_edit",
      "vscode.get_capabilities",
      "vscode.get_diagnostics",
      "vscode.get_open_documents",
      "vscode.get_workspace_info",
      "vscode.read_document"
    ]);
    await expect(
      client.callTool({ name: "vscode.get_workspace_info", arguments: {} })
    ).resolves.toMatchObject({
      structuredContent: { sessionId: "test-session", supportedEnvironment: true }
    });
    await client.close();
  });

  it("keeps independent state for simultaneous clients", async () => {
    const server = await startServer();
    const first = createClient(server.endpoint!);
    const second = createClient(server.endpoint!);

    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);

    expect(first.transport.sessionId).toBeDefined();
    expect(second.transport.sessionId).toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    await Promise.all([first.client.close(), second.client.close()]);
  });

  it("invalidates the old bearer token on the next request after rotation", async () => {
    let activeToken = "before_rotation";
    const server = new BridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      getAccessToken: () => Promise.resolve(activeToken),
      logger: NULL_LOGGER
    });
    activeServers.push(server);
    const endpoint = await server.start();
    const oldClient = createClient(endpoint, activeToken);
    await oldClient.client.connect(oldClient.transport);

    activeToken = "after_rotation";
    await expect(oldClient.client.listTools()).rejects.toBeDefined();
    const replacementClient = createClient(endpoint, activeToken);
    await replacementClient.client.connect(replacementClient.transport);
    await expect(replacementClient.client.listTools()).resolves.toEqual({ tools: [] });

    await Promise.allSettled([oldClient.client.close(), replacementClient.client.close()]);
  });

  it("keeps the MCP session usable after replacing an oversized tool response", async () => {
    const server = await startServer(0, (mcpServer) => {
      mcpServer.registerTool(
        "oversized",
        { inputSchema: z.object({}) },
        () => ({
          content: [
            { type: "text" as const, text: "x".repeat(MAX_TRANSPORT_RESPONSE_BYTES) }
          ]
        })
      );
    });
    const { client, transport } = createClient(server.endpoint!);
    await client.connect(transport);

    await expect(
      client.callTool({ name: "oversized", arguments: {} })
    ).rejects.toMatchObject({
      code: -32603,
      data: { code: "transport-response-too-large" }
    });
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: "oversized" })]
    });
    await client.close();
  });

  it("does not fall back when a fixed port is already occupied", async () => {
    const first = await startServer();
    const occupiedPort = new URL(first.endpoint!).port;
    const second = new BridgeHttpServer({
      host: "127.0.0.1",
      port: Number(occupiedPort),
      getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
      logger: NULL_LOGGER
    });

    await expect(second.start()).rejects.toMatchObject({
      code: "server-start-failed"
    } satisfies Partial<BridgeError>);
  });

  it("rejects concurrent starts and permits a clean restart after coalesced stops", async () => {
    const server = new BridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
      logger: NULL_LOGGER
    });
    activeServers.push(server);

    const firstStart = server.start();
    expect(() => server.start()).toThrowError(
      expect.objectContaining({ code: "server-start-failed" })
    );
    await firstStart;
    await Promise.all([server.stop(), server.stop(), server.stop()]);
    expect(server.endpoint).toBeUndefined();

    await expect(server.start()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("allows stop to win safely when requested during startup", async () => {
    const server = new BridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
      logger: NULL_LOGGER
    });
    activeServers.push(server);

    const starting = server.start();
    const stopping = server.stop();
    await expect(starting).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await stopping;
    expect(server.endpoint).toBeUndefined();
  });
});
