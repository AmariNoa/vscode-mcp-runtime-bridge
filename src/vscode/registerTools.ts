import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { BridgeError } from "../core/errors";
import type { BridgeLogger } from "../core/logging";
import type { VsCodeEditService } from "./editTools";
import type { VsCodeToolsService } from "./workspaceTools";

export function registerVsCodeTools(
  server: McpServer,
  service: VsCodeToolsService,
  logger: BridgeLogger,
  sessionId = "bridge-session",
  editService?: VsCodeEditService
): void {
  server.registerTool(
    "vscode.get_workspace_info",
    {
      description: "Return metadata for the current VS Code window and workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    () => executeTool("vscode.get_workspace_info", logger, () => service.getWorkspaceInfo(sessionId))
  );
  server.registerTool(
    "vscode.get_capabilities",
    {
      description: "Return the Bridge capabilities effective in the current environment.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    () => executeTool("vscode.get_capabilities", logger, () => service.getCapabilities())
  );
  server.registerTool(
    "vscode.get_open_documents",
    {
      description: "List open document metadata without returning document contents.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    () => executeTool("vscode.get_open_documents", logger, () => service.getOpenDocuments())
  );
  server.registerTool(
    "vscode.read_document",
    {
      description: "Read a text document within the current workspace.",
      inputSchema: z.object({ uri: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    ({ uri }) => executeTool("vscode.read_document", logger, () => service.readDocument(uri))
  );
  server.registerTool(
    "vscode.get_diagnostics",
    {
      description: "Return diagnostics for documents in the current workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    () => executeTool("vscode.get_diagnostics", logger, () => service.getDiagnostics())
  );
  if (editService !== undefined) {
    server.registerTool(
      "vscode.apply_edit",
      {
        description: "Apply version-checked UTF-16 text edits within the current workspace.",
        inputSchema: z.object({
          uri: z.string().min(1),
          expectedVersion: z.number().int().nonnegative(),
          edits: z
            .array(
              z.object({
                range: z.object({
                  start: z.object({
                    line: z.number().int().nonnegative(),
                    character: z.number().int().nonnegative()
                  }),
                  end: z.object({
                    line: z.number().int().nonnegative(),
                    character: z.number().int().nonnegative()
                  })
                }),
                newText: z.string()
              })
            )
            .max(1_000)
        }),
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      (input) => executeTool("vscode.apply_edit", logger, () => editService.applyEdit(input))
    );
  }
}

async function executeTool(
  toolName: string,
  logger: BridgeLogger,
  operation: () => Record<string, unknown> | Promise<Record<string, unknown>>
) {
  const startedAt = performance.now();
  try {
    const value = await operation();
    logger.info("tool-completed", {
      toolName,
      durationMs: Math.round(performance.now() - startedAt),
      success: true
    });
    return {
      content: [{ type: "text" as const, text: "Tool completed successfully." }],
      structuredContent: value
    };
  } catch (error) {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError("internal-error", "The tool failed unexpectedly.", undefined, {
            cause: error
          });
    logger.error("tool-completed", {
      toolName,
      durationMs: Math.round(performance.now() - startedAt),
      success: false,
      errorCode: bridgeError.code
    });
    const failure = {
      ok: false,
      error: {
        code: bridgeError.code,
        message: bridgeError.message,
        ...bridgeError.details
      }
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true
    };
  }
}
