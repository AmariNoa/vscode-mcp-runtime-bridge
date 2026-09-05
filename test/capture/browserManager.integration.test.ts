import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class CancellationTokenSource {
    public readonly token = { isCancellationRequested: false };
    public cancel(): void {
      this.token.isCancellationRequested = true;
    }
    public dispose(): void {}
  }
  return { CancellationTokenSource };
});

import type { MfmAdapter } from "../../src/adapters/mfm/adapter";
import { BrowserManager } from "../../src/capture/browserManager";
import { CaptureService } from "../../src/capture/captureService";
import { validatePngAndReadDimensions } from "../../src/capture/png";
import type { VsCodeToolsService } from "../../src/vscode/workspaceTools";

const browserAvailable = existsSync(chromium.executablePath());
const managers: BrowserManager[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
});

describe.skipIf(!browserAvailable)("BrowserManager Chromium integration", () => {
  it(
    "captures a PNG at CSS viewport dimensions and device scale factor",
    async () => {
      const manager = new BrowserManager();
      managers.push(manager);
      const session = await manager.createSession(320, 240, 2);
      await session.page.setContent(
        "<!doctype html><style>body{margin:0;background:#123456}</style><body></body>",
        { waitUntil: "load", timeout: 10_000 }
      );

      const png = await session.page.screenshot({
        type: "png",
        animations: "disabled",
        timeout: 10_000
      });

      expect(validatePngAndReadDimensions(png)).toEqual({ width: 640, height: 480 });
      await session.context.close();
    },
    30_000
  );

  it(
    "blocks a loopback HTTP image before any request reaches the server",
    async () => {
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.statusCode = 204;
        response.end();
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test server did not expose a TCP port.");
      }

      const manager = new BrowserManager();
      managers.push(manager);
      const session = await manager.createSession(320, 240, 1);
      await session.page.setContent(
        `<!doctype html><img src="http://127.0.0.1:${address.port}/forbidden.png">`,
        { waitUntil: "load", timeout: 10_000 }
      );

      expect(requestCount).toBe(0);
      await session.context.close();
    },
    30_000
  );

  it(
    "runs the complete render-to-MCP-image capture pipeline",
    async () => {
      const manager = new BrowserManager();
      managers.push(manager);
      const adapter = {
        getApi: () =>
          Promise.resolve({
            environment: { supported: true },
            capabilities: {
              renderHtml: true,
              standaloneScripts: false,
              embeddedCustomEmoji: true
            },
            limits: { maxHtmlBytes: 1_000_000 }
          }),
        renderHtmlWithToken: () =>
          Promise.resolve({
            ok: true,
            value: {
              html: "<!doctype html><style>body{margin:0;background:#345678}</style><body>capture</body>",
              diagnostics: [],
              notices: [],
              externalResources: []
            }
          })
      } as unknown as MfmAdapter;
      const service = new CaptureService({
        adapter,
        documents: {} as VsCodeToolsService,
        browserManager: manager,
        maximumConcurrent: 1,
        queueLimit: 1
      });

      const result = await service.capture(
        { text: "capture", width: 320, height: 240, deviceScaleFactor: 1 },
        new AbortController().signal
      );

      const image = result.content[0];
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(image?.type).toBe("image");
      if (image?.type !== "image") {
        throw new Error("Expected the capture result to contain an image");
      }
      expect(Buffer.from(image.data, "base64").byteLength).toBeGreaterThan(100);
      expect(result.structuredContent).toMatchObject({
        imageWidthPixels: 320,
        imageHeightPixels: 240,
        capture: { format: "png", browserNetworkPolicy: "deny-all" }
      });
    },
    30_000
  );
});
