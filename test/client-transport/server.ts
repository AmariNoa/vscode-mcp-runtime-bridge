import { BridgeHttpServer } from "../../src/server/bridgeHttpServer";
import type { BridgeLogger } from "../../src/core/logging";
import * as z from "zod/v4";
import { createMaximumPng } from "./maximumPng";
import { MAX_TRANSPORT_RESPONSE_BYTES } from "../../src/core/boundedResponse";

const token = process.env.BRIDGE_CLIENT_TEST_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("BRIDGE_CLIENT_TEST_TOKEN is required.");
}

const logger: BridgeLogger = {
  info: (event, metadata) => writeLog("info", event, metadata),
  error: (event, metadata) => writeLog("error", event, metadata)
};

const server = new BridgeHttpServer({
  host: "127.0.0.1",
  port: 0,
  getAccessToken: () => Promise.resolve(token),
  logger,
  configureMcpServer: (mcpServer) => {
    mcpServer.registerTool(
      "bridge.oversized_transport_probe",
      {
        description: "Exercise the response byte guard; expect transport-response-too-large, then call transport_probe to verify the same session remains usable.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true }
      },
      () => ({ content: [{ type: "text" as const, text: "x".repeat(MAX_TRANSPORT_RESPONSE_BYTES) }] })
    );
    mcpServer.registerTool(
      "bridge.transport_probe",
      {
        description: "Return a small deterministic payload for client transport verification.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true }
      },
      () => ({
        content: [{ type: "text" as const, text: "transport-ok" }],
        structuredContent: { ok: true, transport: "streamable-http" }
      })
    );
    mcpServer.registerTool(
      "bridge.maximum_capture_transport_probe",
      {
        description: "Return a valid PNG at the maximum raw capture size for client transport verification.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true }
      },
      () => {
        const png = createMaximumPng();
        const data = png.toString("base64");
        logger.info("maximum-probe-created", { pngByteLength: png.byteLength, base64Length: data.length });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ pngByteLength: png.byteLength, base64Length: data.length })
            },
            { type: "image" as const, data, mimeType: "image/png" }
          ],
          structuredContent: { pngByteLength: png.byteLength, base64Length: data.length }
        };
      }
    );
  }
});

function writeLog(
  level: "info" | "error",
  event: string,
  metadata?: Readonly<Record<string, unknown>>
): void {
  process.stderr.write(`${JSON.stringify({ level, event, ...metadata })}\n`);
}

const endpoint = await server.start();
process.stdout.write(`${JSON.stringify({ endpoint })}\n`);

await new Promise<void>((resolve) => {
  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void server.stop().finally(resolve);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  process.stdin.resume();
});
