import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { BridgeError } from "../core/errors";
import type { BridgeLogger } from "../core/logging";
import {
  CaptureCancelledError,
  CaptureService,
  type CaptureToolResult
} from "./captureService";

const captureOptions = {
  theme: z.enum(["light", "dark"]).optional(),
  animationsEnabled: z.boolean().optional(),
  instanceProfileId: z.string().min(1).optional(),
  loadCustomEmojis: z.boolean().optional(),
  width: z.number().int().min(128).max(4_096).optional(),
  height: z.number().int().min(128).max(4_096).optional(),
  deviceScaleFactor: z.number().finite().min(1).max(2).optional(),
  format: z.literal("png").optional()
};

const captureInputSchema = z.union([
  z.object({ text: z.string(), ...captureOptions }).strict(),
  z.object({ uri: z.string().min(1), ...captureOptions }).strict()
]);

export function registerCaptureTool(
  server: McpServer,
  captureService: CaptureService,
  logger: BridgeLogger
): void {
  server.registerTool(
    "mfm.capture_preview",
    {
      description: "Render MFM in an isolated deny-all headless browser and return a PNG image.",
      inputSchema: captureInputSchema,
      annotations: { readOnlyHint: true }
    },
    async (input, extra) => {
      const startedAt = performance.now();
      try {
        const result = await captureService.capture(input, extra.signal);
        logResult(logger, startedAt, result);
        return result;
      } catch (error) {
        const code =
          error instanceof CaptureCancelledError
            ? error.code
            : error instanceof BridgeError
              ? error.code
              : "internal-error";
        const message = error instanceof Error ? error.message : "Capture failed unexpectedly.";
        const failure = { ok: false, error: { code, message } };
        logger.error("tool-completed", {
          toolName: "mfm.capture_preview",
          durationMs: Math.round(performance.now() - startedAt),
          success: false,
          errorCode: code
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true
        };
      }
    }
  );
}

function logResult(logger: BridgeLogger, startedAt: number, result: CaptureToolResult): void {
  const failed = "isError" in result && result.isError;
  logger.info("tool-completed", {
    toolName: "mfm.capture_preview",
    durationMs: Math.round(performance.now() - startedAt),
    success: !failed,
    ...(failed ? { errorCode: readErrorCode(result.structuredContent) } : {})
  });
}

function readErrorCode(content: Readonly<Record<string, unknown>>): string {
  const error = content.error;
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "internal-error";
}
