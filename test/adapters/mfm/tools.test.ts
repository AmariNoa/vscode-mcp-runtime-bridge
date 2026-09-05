import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiState = vi.hoisted(() => ({
  api: undefined as Record<string, unknown> | undefined
}));

vi.mock("vscode", () => {
  class CancellationTokenSource {
    public readonly token = { isCancellationRequested: false };
    public cancel(): void {
      this.token.isCancellationRequested = true;
    }
    public dispose(): void {}
  }
  return {
    CancellationTokenSource,
    extensions: {
      getExtension: () =>
        apiState.api === undefined ? undefined : { activate: () => Promise.resolve(apiState.api) }
    }
  };
});

import { MfmAdapter } from "../../../src/adapters/mfm/adapter";
import { registerMfmTools } from "../../../src/adapters/mfm/tools";
import type { CaptureService } from "../../../src/capture/captureService";
import { registerCaptureTool } from "../../../src/capture/tools";
import { NULL_LOGGER } from "../../../src/core/logging";
import { BridgeHttpServer } from "../../../src/server/bridgeHttpServer";
import type { VsCodeToolsService } from "../../../src/vscode/workspaceTools";

const activeServers: BridgeHttpServer[] = [];

function createApi(): Record<string, unknown> {
  return {
    apiVersion: 1,
    astSchemaVersion: 1,
    environment: { supported: true, kind: "desktop-local" },
    capabilities: {
      parse: true,
      validate: true,
      renderHtml: true,
      listInstanceProfiles: true,
      capturePreview: false,
      standaloneScripts: false,
      embeddedCustomEmoji: true
    },
    limits: {
      maxInputCodeUnits: 16_384,
      maxUniqueEmojiRawBytes: 8_388_608,
      maxDataUrlCodeUnits: 12_582_912,
      maxEmojiOccurrences: 512,
      maxSameEmojiOccurrences: 32,
      maxHtmlBytes: 16_777_216
    },
    parse: (text: string) =>
      Promise.resolve({
        ok: true,
        value: { astSchemaVersion: 1, nodes: [{ type: "text", props: { text } }] }
      }),
    validate: () => Promise.resolve({ ok: true, value: { valid: true, diagnostics: [] } }),
    renderHtml: (text: string, options: unknown) =>
      Promise.resolve({
        ok: true,
        value: {
          html: `<!doctype html><body>${text}:${JSON.stringify(options)}</body>`,
          diagnostics: [],
          notices: [],
          externalResources: []
        }
      }),
    listInstanceProfiles: () =>
      Promise.resolve({
        ok: true,
        value: [
          {
            id: "profile-1",
            label: "Test",
            origin: "https://example.invalid",
            approvedResourceOrigins: []
          }
        ]
      })
  };
}

afterEach(async () => {
  apiState.api = undefined;
  await Promise.allSettled(activeServers.splice(0).map((server) => server.stop()));
});

async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const documents = {
    readDocument: (uri: string) => Promise.resolve({ uri, text: "unsaved document text" })
  } as unknown as VsCodeToolsService;
  const server = new BridgeHttpServer({
    host: "127.0.0.1",
    port: 0,
    getAccessToken: () => Promise.resolve("mfm_test_token"),
    logger: NULL_LOGGER,
    configureMcpServer: (mcpServer) => {
      registerMfmTools(mcpServer, new MfmAdapter(), documents, NULL_LOGGER);
      registerCaptureTool(
        mcpServer,
        {
          capture: () =>
            Promise.resolve({
              content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
              structuredContent: {
                mimeType: "image/png",
                capture: { format: "png", browserNetworkPolicy: "deny-all" }
              }
            })
        } as unknown as CaptureService,
        NULL_LOGGER
      );
    }
  });
  activeServers.push(server);
  const endpoint = await server.start();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: "Bearer mfm_test_token" } }
  });
  const client = new Client({ name: "mfm-tool-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MFM MCP tools", () => {
  it("registers the MFM and capture tools and forwards text results", async () => {
    apiState.api = createApi();
    const { client } = await connect();

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "mfm.capture_preview",
      "mfm.list_instance_profiles",
      "mfm.parse",
      "mfm.render_html",
      "mfm.validate"
    ]);
    await expect(
      client.callTool({ name: "mfm.parse", arguments: { text: "hello" } })
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        value: { astSchemaVersion: 1, nodes: [{ type: "text", props: { text: "hello" } }] }
      }
    });
    await client.close();
  });

  it("returns capture PNG as MCP image content with structured metadata", async () => {
    apiState.api = createApi();
    const { client } = await connect();

    await expect(
      client.callTool({ name: "mfm.capture_preview", arguments: { text: "preview" } })
    ).resolves.toMatchObject({
      content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      structuredContent: {
        mimeType: "image/png",
        capture: { format: "png", browserNetworkPolicy: "deny-all" }
      }
    });
    await client.close();
  });

  it("prefers unsaved VS Code document text for URI input", async () => {
    apiState.api = createApi();
    const { client } = await connect();

    await expect(
      client.callTool({ name: "mfm.parse", arguments: { uri: "file:///workspace/sample.mfm" } })
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        value: {
          nodes: [{ type: "text", props: { text: "unsaved document text" } }]
        }
      }
    });
    await client.close();
  });

  it("forwards render options and lists profile metadata", async () => {
    apiState.api = createApi();
    const { client } = await connect();

    await expect(
      client.callTool({
        name: "mfm.render_html",
        arguments: { text: "preview", theme: "dark", animationsEnabled: false }
      })
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        value: { html: expect.stringContaining('"theme":"dark"') }
      }
    });
    await expect(
      client.callTool({ name: "mfm.list_instance_profiles", arguments: {} })
    ).resolves.toMatchObject({
      structuredContent: { ok: true, value: [{ id: "profile-1" }] }
    });
    await client.close();
  });

  it("rejects ambiguous source input before invoking the extension", async () => {
    let parseCalls = 0;
    apiState.api = { ...createApi(), parse: () => { parseCalls += 1; return Promise.resolve({ ok: true, value: { astSchemaVersion: 1, nodes: [] } }); } };
    const { client } = await connect();

    const result = await client.callTool({
      name: "mfm.parse",
      arguments: { text: "text", uri: "file:///workspace/sample.mfm" }
    });

    expect(result.isError).toBe(true);
    expect(parseCalls).toBe(0);
    await client.close();
  });
});
