import { performance } from "node:perf_hooks";
import type { BrowserContextHandle, BrowserPageHandle } from "./browserManager";
import { BrowserManager } from "./browserManager";
import { validateStandaloneHtml } from "./htmlPolicy";
import {
  normalizeCaptureInput,
  type CapturePreviewInput,
  type NormalizedCapturePreviewInput
} from "./input";
import { validatePngAndReadDimensions } from "./png";
import * as vscode from "vscode";
import { MfmAdapter } from "../adapters/mfm/adapter";
import type { MfmApiFailure, MfmRenderOptions } from "../adapters/mfm/contract";
import { BridgeError } from "../core/errors";
import type { VsCodeToolsService } from "../vscode/workspaceTools";

export const CAPTURE_TIMEOUT_MS = 15_000;

export const CAPTURE_STAGES = [
  "dequeued",
  "source-resolved",
  "mfm-rendered",
  "html-validated",
  "browser-started",
  "page-created",
  "layout-complete",
  "screenshot-complete",
  "png-encoded",
  "png-validated",
  "base64-complete",
  "structured-content-created",
  "tool-result-created",
  "terminal-commit"
] as const;

export type CaptureStage = (typeof CAPTURE_STAGES)[number];
type TimerHandle = ReturnType<typeof setTimeout>;

export type CaptureToolResult =
  | {
      readonly content: Array<
        {
          readonly type: "image";
          readonly mimeType: "image/png";
          readonly data: string;
        }
      >;
      readonly structuredContent: Readonly<Record<string, unknown>>;
    }
  | {
      readonly content: Array<{ readonly type: "text"; readonly text: string }>;
      readonly structuredContent: Readonly<Record<string, unknown>>;
      readonly isError: true;
    };

interface CaptureExecutionState {
  callerCancelled: boolean;
  timedOut: boolean;
  terminal: boolean;
  readonly timeoutDeadlineAtMonotonicMs: number;
  readonly callerToken: vscode.CancellationToken;
  readonly callerCancellation: vscode.CancellationTokenSource;
  readonly mfmCancellation: vscode.CancellationTokenSource;
  readonly callerSignal: AbortSignal;
  timeoutTimer?: TimerHandle;
  browserPage?: BrowserPageHandle;
  browserContext?: BrowserContextHandle;
}

interface QueueEntry {
  readonly input: NormalizedCapturePreviewInput;
  readonly state: CaptureExecutionState;
  readonly resolve: (value: CaptureToolResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly onCallerAbort: () => void;
  started: boolean;
}

export interface CaptureServiceOptions {
  readonly adapter: MfmAdapter;
  readonly documents: VsCodeToolsService;
  readonly browserManager: BrowserManager;
  readonly maximumConcurrent: number;
  readonly queueLimit: number;
  readonly timeoutMs?: number;
  readonly monotonicNow?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly stageObserver?: (stage: CaptureStage) => void;
}

interface RenderValue {
  readonly html: string;
  readonly diagnostics: readonly unknown[];
  readonly notices: readonly unknown[];
  readonly externalResources: readonly unknown[];
}

export class CaptureCancelledError extends Error {
  public readonly code = "cancelled" as const;

  public constructor() {
    super("The MCP caller cancelled the capture.");
    this.name = "CaptureCancelledError";
  }
}

export class CaptureService {
  private readonly queue: QueueEntry[] = [];
  private readonly now: () => number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;
  private readonly timeoutMs: number;
  private active = 0;

  public constructor(private readonly options: CaptureServiceOptions) {
    if (!Number.isInteger(options.maximumConcurrent) || options.maximumConcurrent < 1 || options.maximumConcurrent > 2) {
      throw new BridgeError("invalid-tool-input", "maximumConcurrent must be 1 or 2.");
    }
    if (!Number.isInteger(options.queueLimit) || options.queueLimit < 0 || options.queueLimit > 8) {
      throw new BridgeError("invalid-tool-input", "queueLimit must be an integer from 0 through 8.");
    }
    this.now = options.monotonicNow ?? (() => performance.now());
    this.scheduleTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  }

  public capture(input: CapturePreviewInput, callerSignal: AbortSignal): Promise<CaptureToolResult> {
    const normalized = normalizeCaptureInput(input);
    const callerCancellation = new vscode.CancellationTokenSource();
    const mfmCancellation = new vscode.CancellationTokenSource();
    const state: CaptureExecutionState = {
      callerCancelled: callerSignal.aborted,
      timedOut: false,
      terminal: false,
      timeoutDeadlineAtMonotonicMs: this.now() + this.timeoutMs,
      callerToken: callerCancellation.token,
      callerCancellation,
      mfmCancellation,
      callerSignal
    };
    if (callerSignal.aborted) {
      callerCancellation.cancel();
    }

    return new Promise<CaptureToolResult>((resolve, reject) => {
      const entry: QueueEntry = {
        input: normalized,
        state,
        resolve,
        reject,
        started: false,
        onCallerAbort: () => {
          state.callerCancelled = true;
          state.callerCancellation.cancel();
          state.mfmCancellation.cancel();
          this.terminate(entry, new CaptureCancelledError());
        }
      };
      callerSignal.addEventListener("abort", entry.onCallerAbort, { once: true });
      state.timeoutTimer = this.scheduleTimer(() => {
        if (state.terminal) {
          return;
        }
        if (callerSignal.aborted || state.callerToken.isCancellationRequested) {
          state.callerCancelled = true;
          this.terminate(entry, new CaptureCancelledError());
          return;
        }
        state.timedOut = true;
        state.mfmCancellation.cancel();
        this.terminate(entry, captureTimeoutError());
      }, this.timeoutMs);

      if (state.callerCancelled) {
        this.terminate(entry, new CaptureCancelledError());
      } else if (this.active < this.options.maximumConcurrent) {
        this.start(entry);
      } else if (this.queue.length < this.options.queueLimit) {
        this.queue.push(entry);
      } else {
        this.terminate(
          entry,
          new BridgeError("capture-queue-full", "The shared capture queue is full.", {
            queueLimit: this.options.queueLimit
          })
        );
      }
    });
  }

  private start(entry: QueueEntry): void {
    entry.started = true;
    this.active += 1;
    void this.runEntry(entry);
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    try {
      const result = await this.execute(entry);
      await this.cleanupBrowser(entry.state);
      this.settleSuccess(entry, result);
    } catch (error) {
      await this.cleanupBrowser(entry.state);
      this.terminate(entry, error);
    } finally {
      entry.state.mfmCancellation.dispose();
      this.active -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    while (this.active < this.options.maximumConcurrent) {
      const next = this.queue.shift();
      if (next === undefined) {
        return;
      }
      if (!next.state.terminal) {
        this.start(next);
      }
    }
  }

  private async execute(entry: QueueEntry): Promise<CaptureToolResult> {
    const { input, state } = entry;
    this.checkpoint(state, "dequeued");
    const source = await this.resolveSource(input);
    this.checkpoint(state, "source-resolved");

    const api = await this.options.adapter.getApi();
    if (
      api.capabilities.renderHtml !== true ||
      api.capabilities.standaloneScripts !== false ||
      api.capabilities.embeddedCustomEmoji !== true
    ) {
      throw new BridgeError(
        "extension-capability-mismatch",
        "The MFM capture security capabilities are incompatible."
      );
    }
    if (!api.environment.supported) {
      return this.commitFailure(state, { ok: false, error: { code: "unsupported-environment" } });
    }
    if (!(await this.options.browserManager.isAvailable())) {
      throw new BridgeError("browser-unavailable", "The bundled Chromium executable is unavailable.");
    }

    const renderResult = await this.options.adapter.renderHtmlWithToken(
      source,
      renderOptions(input),
      state.mfmCancellation.token
    );
    this.checkpoint(state, "mfm-rendered");
    if (!renderResult.ok) {
      return this.commitFailure(state, renderResult);
    }
    const renderValue = renderResult.value as RenderValue;
    validateStandaloneHtml(renderValue.html, api.limits.maxHtmlBytes);
    this.checkpoint(state, "html-validated");

    await this.options.browserManager.ensureBrowser();
    this.checkpoint(state, "browser-started");
    const session = await this.options.browserManager.createSession(
      input.width,
      input.height,
      input.deviceScaleFactor
    );
    state.browserContext = session.context;
    state.browserPage = session.page;
    this.checkpoint(state, "page-created");

    await session.page.setContent(renderValue.html, {
      waitUntil: "load",
      timeout: this.remainingMs(state)
    });
    await session.page.evaluate(
      () =>
        (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready
    );
    this.checkpoint(state, "layout-complete");

    const screenshot = await session.page.screenshot({
      type: "png",
      animations: input.animationsEnabled ? "allow" : "disabled",
      timeout: this.remainingMs(state)
    });
    this.checkpoint(state, "screenshot-complete");
    const pngBytes = Buffer.from(screenshot);
    this.checkpoint(state, "png-encoded");
    const dimensions = validatePngAndReadDimensions(pngBytes);
    this.checkpoint(state, "png-validated");
    const base64 = pngBytes.toString("base64");
    this.checkpoint(state, "base64-complete");

    const structuredContent = {
      mimeType: "image/png",
      viewportWidthCssPixels: input.width,
      viewportHeightCssPixels: input.height,
      deviceScaleFactor: input.deviceScaleFactor,
      imageWidthPixels: dimensions.width,
      imageHeightPixels: dimensions.height,
      pngByteLength: pngBytes.byteLength,
      diagnostics: renderValue.diagnostics,
      notices: renderValue.notices,
      externalResources: renderValue.externalResources,
      knownVisualDifferences: source.includes("$[sparkle")
        ? (["sparkle-static-fallback"] as const)
        : ([] as const),
      capture: {
        format: "png",
        browserNetworkPolicy: "deny-all"
      }
    };
    this.checkpoint(state, "structured-content-created");
    const toolResult: CaptureToolResult = {
      content: [{ type: "image", mimeType: "image/png", data: base64 }],
      structuredContent
    };
    this.checkpoint(state, "tool-result-created");
    this.checkpoint(state, "terminal-commit");
    return toolResult;
  }

  private async resolveSource(input: NormalizedCapturePreviewInput): Promise<string> {
    if (input.source.kind === "text") {
      return input.source.text;
    }
    const document = await this.options.documents.readDocument(input.source.uri);
    if (typeof document.text !== "string") {
      throw new BridgeError("document-not-readable", "The VS Code document did not contain text.");
    }
    return document.text;
  }

  private commitFailure(state: CaptureExecutionState, failure: MfmApiFailure): CaptureToolResult {
    this.checkpoint(state, "structured-content-created");
    const result: CaptureToolResult = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(failure)
        }
      ],
      structuredContent: failure as unknown as Readonly<Record<string, unknown>>,
      isError: true
    };
    this.checkpoint(state, "tool-result-created");
    this.checkpoint(state, "terminal-commit");
    return result;
  }

  private checkpoint(state: CaptureExecutionState, stage: CaptureStage): void {
    this.options.stageObserver?.(stage);
    if (state.callerSignal.aborted || state.callerCancelled || state.callerToken.isCancellationRequested) {
      state.callerCancelled = true;
      state.mfmCancellation.cancel();
      throw new CaptureCancelledError();
    }
    if (state.timedOut || this.now() >= state.timeoutDeadlineAtMonotonicMs) {
      state.timedOut = true;
      state.mfmCancellation.cancel();
      throw captureTimeoutError();
    }
  }

  private remainingMs(state: CaptureExecutionState): number {
    return Math.max(1, Math.ceil(state.timeoutDeadlineAtMonotonicMs - this.now()));
  }

  private settleSuccess(entry: QueueEntry, result: CaptureToolResult): void {
    if (entry.state.terminal) {
      return;
    }
    entry.state.terminal = true;
    this.finishTerminal(entry);
    entry.resolve(result);
  }

  private terminate(entry: QueueEntry, error: unknown): void {
    const { state } = entry;
    if (state.terminal) {
      return;
    }
    if (state.callerSignal.aborted || state.callerToken.isCancellationRequested) {
      state.callerCancelled = true;
      error = new CaptureCancelledError();
    } else if (state.timedOut || this.now() >= state.timeoutDeadlineAtMonotonicMs) {
      state.timedOut = true;
      error = captureTimeoutError();
    }
    state.terminal = true;
    state.mfmCancellation.cancel();
    if (!entry.started) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      state.mfmCancellation.dispose();
    }
    this.finishTerminal(entry);
    void this.cleanupBrowser(state);
    entry.reject(error);
  }

  private finishTerminal(entry: QueueEntry): void {
    const { state } = entry;
    if (state.timeoutTimer !== undefined) {
      this.cancelTimer(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }
    state.callerSignal.removeEventListener("abort", entry.onCallerAbort);
    state.callerCancellation.dispose();
  }

  private cleanupBrowser(state: CaptureExecutionState): Promise<void> {
    const page = state.browserPage;
    const context = state.browserContext;
    state.browserPage = undefined;
    state.browserContext = undefined;
    return Promise.allSettled([
      page?.close({ runBeforeUnload: false }),
      context?.close()
    ]).then(() => undefined);
  }
}

function renderOptions(input: NormalizedCapturePreviewInput): MfmRenderOptions {
  return {
    theme: input.theme,
    animationsEnabled: input.animationsEnabled,
    loadCustomEmojis: input.loadCustomEmojis,
    ...(input.instanceProfileId === undefined
      ? {}
      : { instanceProfileId: input.instanceProfileId })
  };
}

function captureTimeoutError(): BridgeError {
  return new BridgeError("capture-timeout", "The capture exceeded its monotonic deadline.");
}
