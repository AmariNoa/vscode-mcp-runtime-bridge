import assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "noa-amari.vscode-mcp-runtime-bridge";

interface ClientConfiguration {
  readonly mcpServers: {
    readonly vscode: {
      readonly url: string;
      readonly headers: { readonly Authorization: string };
    };
  };
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not installed in the test host.`);
  await extension.activate();

  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand("vscodeMcp.copyClientConfiguration");
    const configuration = JSON.parse(
      await vscode.env.clipboard.readText()
    ) as ClientConfiguration;
    const endpoint = new URL(configuration.mcpServers.vscode.url);
    const authorization = configuration.mcpServers.vscode.headers.Authorization;
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.equal(endpoint.pathname, "/mcp");
    assert.match(authorization, /^Bearer [A-Za-z0-9_-]{43}$/);

    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer invalid", "content-type": "application/json" },
      body: "not-json"
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await readErrorCode(unauthorized)), "authentication-failed");

    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, "content-type": "application/json" },
      body: "not-json"
    });
    assert.equal(malformed.status, 400);
    assert.equal((await readErrorCode(malformed)), "invalid-tool-input");

    const initialized = await postJson(
      endpoint,
      authorization,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vscode-extension-host-test", version: "1.0.0" }
        }
      }
    );
    assert.equal(initialized.response.status, 200);
    const sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId);

    await postJson(
      endpoint,
      authorization,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId
    );
    const listed = await postJson(
      endpoint,
      authorization,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId
    );
    const toolNames = readToolNames(listed.body);
    for (const required of [
      "vscode.get_workspace_info",
      "vscode.get_capabilities",
      "vscode.get_open_documents",
      "vscode.read_document",
      "vscode.apply_edit",
      "vscode.get_diagnostics",
      "mfm.parse",
      "mfm.validate",
      "mfm.list_instance_profiles",
      "mfm.render_html",
      "mfm.capture_preview"
    ]) {
      assert.ok(toolNames.includes(required), `Tool ${required} was not registered.`);
    }

    const workspaceInfo = await postJson(
      endpoint,
      authorization,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vscode.get_workspace_info", arguments: {} }
      },
      sessionId
    );
    const structuredContent = readStructuredContent(workspaceInfo.body);
    assert.equal(structuredContent.supportedEnvironment, true);
    assert.equal(typeof structuredContent.sessionId, "string");

    const terminated = await fetch(endpoint, {
      method: "DELETE",
      headers: {
        Authorization: authorization,
        "mcp-session-id": sessionId
      }
    });
    assert.ok(terminated.status === 200 || terminated.status === 204);
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
}

async function postJson(
  endpoint: URL,
  authorization: string,
  body: unknown,
  sessionId?: string
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId })
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, body: text.length === 0 ? undefined : JSON.parse(text) };
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as {
    readonly error?: { readonly data?: { readonly code?: string } };
  };
  return body.error?.data?.code;
}

function readToolNames(body: unknown): string[] {
  const value = body as {
    readonly result?: { readonly tools?: ReadonlyArray<{ readonly name?: unknown }> };
  };
  return (value.result?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}

function readStructuredContent(body: unknown): Readonly<Record<string, unknown>> {
  const value = body as {
    readonly result?: { readonly structuredContent?: Readonly<Record<string, unknown>> };
  };
  assert.ok(value.result?.structuredContent);
  return value.result.structuredContent;
}
