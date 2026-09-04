import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/core/errors";
import { NULL_LOGGER } from "../../src/core/logging";
import { BridgeHttpServer } from "../../src/server/bridgeHttpServer";
import { registerVsCodeTools } from "../../src/vscode/registerTools";
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
    const server = await startServer(0, (mcpServer) =>
      registerVsCodeTools(mcpServer, service, NULL_LOGGER, "test-session")
    );
    const { client, transport } = createClient(server.endpoint!);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
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
});
