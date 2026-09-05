import { BridgeHttpServer } from "../../src/server/bridgeHttpServer";
import { NULL_LOGGER } from "../../src/core/logging";
import * as z from "zod/v4";

const token = process.env.BRIDGE_CLIENT_TEST_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("BRIDGE_CLIENT_TEST_TOKEN is required.");
}

const server = new BridgeHttpServer({
  host: "127.0.0.1",
  port: 0,
  getAccessToken: () => Promise.resolve(token),
  logger: NULL_LOGGER,
  configureMcpServer: (mcpServer) => {
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
  }
});

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
