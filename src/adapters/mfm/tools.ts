import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { BridgeError } from "../../core/errors";
import type { BridgeLogger } from "../../core/logging";
import type { VsCodeToolsService } from "../../vscode/workspaceTools";
import { MfmAdapter } from "./adapter";
import type { MfmApiResult, MfmRenderOptions } from "./contract";

const textSourceSchema = z.object({ text: z.string() }).strict();
const uriSourceSchema = z.object({ uri: z.string().min(1) }).strict();
const sourceSchema = z.union([textSourceSchema, uriSourceSchema]);
const renderOptionsShape = {
  theme: z.enum(["light", "dark"]).optional(),
  animationsEnabled: z.boolean().optional(),
  instanceProfileId: z.string().min(1).optional(),
  loadCustomEmojis: z.boolean().optional()
};
const renderInputSchema = z.union([
  z.object({ text: z.string(), ...renderOptionsShape }).strict(),
  z.object({ uri: z.string().min(1), ...renderOptionsShape }).strict()
]);

export function registerMfmTools(
  server: McpServer,
  adapter: MfmAdapter,
  documents: VsCodeToolsService,
  logger: BridgeLogger
): void {
  server.registerTool(
    "mfm.parse",
    {
      description: "Parse MFM through the approved MFM Language Support public API.",
      inputSchema: sourceSchema,
      annotations: { readOnlyHint: true }
    },
    (input, extra) =>
      executeMfmTool("mfm.parse", logger, async () =>
        adapter.parse(await readSource(input, documents), extra.signal)
      )
  );
  server.registerTool(
    "mfm.validate",
    {
      description: "Validate MFM through the approved MFM Language Support public API.",
      inputSchema: sourceSchema,
      annotations: { readOnlyHint: true }
    },
    (input, extra) =>
      executeMfmTool("mfm.validate", logger, async () =>
        adapter.validate(await readSource(input, documents), extra.signal)
      )
  );
  server.registerTool(
    "mfm.list_instance_profiles",
    {
      description: "List approved MFM instance profile metadata.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    (_input, extra) =>
      executeMfmTool("mfm.list_instance_profiles", logger, () =>
        adapter.listInstanceProfiles(extra.signal)
      )
  );
  server.registerTool(
    "mfm.render_html",
    {
      description: "Render standalone MFM HTML through the approved public API.",
      inputSchema: renderInputSchema,
      annotations: { readOnlyHint: true }
    },
    (input, extra) =>
      executeMfmTool("mfm.render_html", logger, async () => {
        const { source, options } = await readRenderInput(input, documents);
        return adapter.renderHtml(source, options, extra.signal);
      })
  );
}

async function readSource(
  input: z.infer<typeof sourceSchema>,
  documents: VsCodeToolsService
): Promise<string> {
  if ("text" in input) {
    return input.text;
  }
  const document = await documents.readDocument(input.uri);
  if (typeof document.text !== "string") {
    throw new BridgeError("document-not-readable", "The VS Code document did not contain text.");
  }
  return document.text;
}

async function readRenderInput(
  input: z.infer<typeof renderInputSchema>,
  documents: VsCodeToolsService
): Promise<{ source: string; options: MfmRenderOptions }> {
  const source = await readSource(
    "text" in input ? { text: input.text } : { uri: input.uri },
    documents
  );
  return {
    source,
    options: {
      ...(input.theme === undefined ? {} : { theme: input.theme }),
      ...(input.animationsEnabled === undefined
        ? {}
        : { animationsEnabled: input.animationsEnabled }),
      ...(input.instanceProfileId === undefined
        ? {}
        : { instanceProfileId: input.instanceProfileId }),
      ...(input.loadCustomEmojis === undefined
        ? {}
        : { loadCustomEmojis: input.loadCustomEmojis })
    }
  };
}

async function executeMfmTool(
  toolName: string,
  logger: BridgeLogger,
  operation: () => Promise<MfmApiResult<unknown>>
) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    logger.info("tool-completed", {
      toolName,
      durationMs: Math.round(performance.now() - startedAt),
      success: result.ok,
      ...(!result.ok ? { errorCode: result.error.code } : {})
    });
    return {
      content: [
        {
          type: "text" as const,
          text: result.ok ? "MFM operation completed successfully." : JSON.stringify(result)
        }
      ],
      structuredContent: result,
      ...(!result.ok ? { isError: true } : {})
    };
  } catch (error) {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError("internal-error", "The MFM tool failed unexpectedly.", undefined, {
            cause: error
          });
    const failure = { ok: false as const, error: { code: bridgeError.code, message: bridgeError.message } };
    logger.error("tool-completed", {
      toolName,
      durationMs: Math.round(performance.now() - startedAt),
      success: false,
      errorCode: bridgeError.code
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true
    };
  }
}
