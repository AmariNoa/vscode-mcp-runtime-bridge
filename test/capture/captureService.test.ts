import { describe, expect, it, vi } from "vitest";

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
import type { BrowserManager } from "../../src/capture/browserManager";
import {
  CAPTURE_STAGES,
  CaptureService,
  type CaptureStage
} from "../../src/capture/captureService";
import { MAX_PNG_BYTES } from "../../src/capture/png";
import type { VsCodeToolsService } from "../../src/vscode/workspaceTools";

function pngFixture(width = 1_024, height = 768, byteLength = 24): Buffer {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function successfulRender(html = "<!doctype html><body>safe</body>") {
  return {
    ok: true as const,
    value: {
      html,
      diagnostics: [{ code: "unknown-function" }],
      notices: [{ code: "custom-emoji-fetch-failed" }],
      externalResources: [{ kind: "custom-emoji", sha256: "a".repeat(64) }]
    }
  };
}

interface FakeState {
  stages: CaptureStage[];
  pageCloses: number;
  contextCloses: number;
  browserStarts: number;
  screenshots: number;
  readUris: string[];
}

function createService(options: {
  now?: () => number;
  observer?: (stage: CaptureStage) => void;
  render?: () => Promise<unknown>;
  screenshot?: Buffer;
  maximumConcurrent?: number;
  queueLimit?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
} = {}): { service: CaptureService; state: FakeState } {
  const state: FakeState = {
    stages: [],
    pageCloses: 0,
    contextCloses: 0,
    browserStarts: 0,
    screenshots: 0,
    readUris: []
  };
  const page = {
    setContent: () => Promise.resolve(),
    evaluate: () => Promise.resolve(),
    screenshot: () => {
      state.screenshots += 1;
      return Promise.resolve(options.screenshot ?? pngFixture());
    },
    close: () => {
      state.pageCloses += 1;
      return Promise.resolve();
    }
  };
  const context = {
    route: () => Promise.resolve(),
    newPage: () => Promise.resolve(page),
    close: () => {
      state.contextCloses += 1;
      return Promise.resolve();
    }
  };
  const browserManager = {
    isAvailable: () => Promise.resolve(true),
    ensureBrowser: () => {
      state.browserStarts += 1;
      return Promise.resolve({});
    },
    createSession: () => Promise.resolve({ context, page })
  } as unknown as BrowserManager;
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
      options.render === undefined ? Promise.resolve(successfulRender()) : options.render()
  } as unknown as MfmAdapter;
  const documents = {
    readDocument: (uri: string) => {
      state.readUris.push(uri);
      return Promise.resolve({ text: "unsaved source" });
    }
  } as unknown as VsCodeToolsService;
  const service = new CaptureService({
    adapter,
    documents,
    browserManager,
    maximumConcurrent: options.maximumConcurrent ?? 2,
    queueLimit: options.queueLimit ?? 8,
    timeoutMs: 100,
    monotonicNow: options.now ?? (() => 0),
    setTimer:
      options.setTimer ??
      (() => ({}) as ReturnType<typeof setTimeout>),
    clearTimer: () => undefined,
    stageObserver: (stage) => {
      state.stages.push(stage);
      options.observer?.(stage);
    }
  });
  return { service, state };
}

describe("CaptureService", () => {
  it("produces PNG content and normative ordered metadata from one execution", async () => {
    const { service, state } = createService({ screenshot: pngFixture(2_048, 1_536) });

    const result = await service.capture(
      { text: "$[sparkle text]", width: 1_024, height: 768, deviceScaleFactor: 2 },
      new AbortController().signal
    );

    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: pngFixture(2_048, 1_536).toString("base64")
    });
    expect(result.structuredContent).toMatchObject({
      viewportWidthCssPixels: 1_024,
      viewportHeightCssPixels: 768,
      deviceScaleFactor: 2,
      imageWidthPixels: 2_048,
      imageHeightPixels: 1_536,
      pngByteLength: 24,
      diagnostics: [{ code: "unknown-function" }],
      notices: [{ code: "custom-emoji-fetch-failed" }],
      externalResources: [{ kind: "custom-emoji" }],
      knownVisualDifferences: ["sparkle-static-fallback"],
      capture: { format: "png", browserNetworkPolicy: "deny-all" }
    });
    expect(state.stages).toEqual(CAPTURE_STAGES);
    expect(state.pageCloses).toBe(1);
    expect(state.contextCloses).toBe(1);
  });

  it("resolves URI input through the current VS Code document", async () => {
    const { service, state } = createService();

    await service.capture(
      { uri: "file:///workspace/sample.mfm" },
      new AbortController().signal
    );

    expect(state.readUris).toEqual(["file:///workspace/sample.mfm"]);
  });

  it("returns an MFM failure without starting a browser", async () => {
    const { service, state } = createService({
      render: () => Promise.resolve({ ok: false, error: { code: "parser-failure" } })
    });

    const result = await service.capture({ text: "broken" }, new AbortController().signal);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "parser-failure" } }
    });
    expect(state.browserStarts).toBe(0);
  });

  it("rejects oversized PNG bytes before the base64 stage", async () => {
    const { service, state } = createService({ screenshot: pngFixture(1, 1, MAX_PNG_BYTES + 1) });

    await expect(
      service.capture({ text: "text" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "capture-output-too-large" });
    expect(state.stages).not.toContain("base64-complete");
  });

  it.each(CAPTURE_STAGES)("detects a monotonic deadline after %s", async (targetStage) => {
    let now = 0;
    const { service } = createService({
      now: () => now,
      observer: (stage) => {
        if (stage === targetStage) {
          now = 100;
        }
      }
    });

    await expect(
      service.capture({ text: "text" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "capture-timeout" });
  });

  it("prioritizes caller cancellation when it races the deadline", async () => {
    let now = 0;
    const caller = new AbortController();
    const { service } = createService({
      now: () => now,
      observer: (stage) => {
        if (stage === "terminal-commit") {
          now = 100;
          caller.abort();
        }
      }
    });

    await expect(service.capture({ text: "text" }, caller.signal)).rejects.toMatchObject({
      code: "cancelled"
    });
  });

  it("shares concurrency and queue limits across callers", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const { service } = createService({
      maximumConcurrent: 1,
      queueLimit: 1,
      render: () => new Promise((resolve) => pending.push(resolve))
    });
    const first = service.capture({ text: "first" }, new AbortController().signal);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = service.capture({ text: "second" }, new AbortController().signal);

    await expect(
      service.capture({ text: "third" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "capture-queue-full" });
    pending[0]!(successfulRender());
    await expect(first).resolves.toHaveProperty("content.0.type", "image");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(successfulRender());
    await expect(second).resolves.toHaveProperty("content.0.type", "image");
  });

  it("removes a queued caller when its timeout fires", async () => {
    const timerCallbacks: Array<() => void> = [];
    const pending: Array<(value: unknown) => void> = [];
    let now = 0;
    const { service } = createService({
      maximumConcurrent: 1,
      queueLimit: 1,
      now: () => now,
      setTimer: (callback) => {
        timerCallbacks.push(callback);
        return {} as ReturnType<typeof setTimeout>;
      },
      render: () => new Promise((resolve) => pending.push(resolve))
    });
    const first = service.capture({ text: "first" }, new AbortController().signal);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = service.capture({ text: "second" }, new AbortController().signal);
    now = 100;
    timerCallbacks[1]!();

    await expect(second).rejects.toMatchObject({ code: "capture-timeout" });
    now = 0;
    pending[0]!(successfulRender());
    await expect(first).resolves.toHaveProperty("content.0.type", "image");
    expect(pending).toHaveLength(1);
  });
});
