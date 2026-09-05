import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { BridgeError } from "../core/errors";
import { isBrowserUrlAllowed } from "./htmlPolicy";

export interface BrowserPageHandle {
  setContent(html: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  evaluate(expression: () => Promise<unknown>): Promise<unknown>;
  screenshot(options: {
    type: "png";
    animations: "allow" | "disabled";
    timeout: number;
  }): Promise<Buffer>;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
}

export interface BrowserContextHandle {
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(errorCode?: string): Promise<void>;
    }) => Promise<void>
  ): Promise<void>;
  newPage(): Promise<BrowserPageHandle>;
  close(): Promise<void>;
}

export interface BrowserHandle {
  isConnected(): boolean;
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    javaScriptEnabled: boolean;
    serviceWorkers: "block";
  }): Promise<BrowserContextHandle>;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): void;
}

export interface BrowserLauncher {
  executablePath(): string;
  launch(options: {
    headless: true;
    args: readonly string[];
    executablePath: string;
  }): Promise<BrowserHandle>;
}

export interface BrowserManagerOptions {
  readonly launcher?: BrowserLauncher;
  readonly executableExists?: (path: string) => Promise<boolean>;
  readonly resolveExecutablePath?: () => Promise<string | undefined>;
}

interface BundledBrowserManifest {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly executablePath: string;
}

export interface CaptureBrowserSession {
  readonly context: BrowserContextHandle;
  readonly page: BrowserPageHandle;
}

const HARDENED_CHROMIUM_ARGUMENTS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run"
] as const;

export class BrowserManager {
  private browser: BrowserHandle | undefined;
  private pendingLaunch: Promise<BrowserHandle> | undefined;
  private closed = false;

  private readonly launcher: BrowserLauncher;
  private readonly executableExists: (path: string) => Promise<boolean>;
  private readonly resolveExecutablePath: () => Promise<string | undefined>;

  public constructor(options: BrowserManagerOptions = {}) {
    this.launcher = options.launcher ?? (chromium as unknown as BrowserLauncher);
    this.executableExists = options.executableExists ?? defaultExecutableExists;
    this.resolveExecutablePath =
      options.resolveExecutablePath ?? (() => Promise.resolve(this.launcher.executablePath()));
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const executablePath = await this.resolveExecutablePath();
      return executablePath !== undefined && (await this.executableExists(executablePath));
    } catch {
      return false;
    }
  }

  public async ensureBrowser(): Promise<BrowserHandle> {
    if (this.closed) {
      throw new BridgeError("browser-unavailable", "The browser manager is closed.");
    }
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.pendingLaunch !== undefined) {
      return this.pendingLaunch;
    }
    this.pendingLaunch = this.launchAvailableBrowser();
    try {
      return await this.pendingLaunch;
    } finally {
      this.pendingLaunch = undefined;
    }
  }

  private async launchAvailableBrowser(): Promise<BrowserHandle> {
    const executablePath = await this.resolveExecutablePath().catch(() => undefined);
    if (executablePath === undefined || !(await this.executableExists(executablePath))) {
      throw new BridgeError("browser-unavailable", "The bundled Chromium executable is unavailable.");
    }
    return this.launchBrowser(executablePath);
  }

  public async createSession(
    width: number,
    height: number,
    deviceScaleFactor: number
  ): Promise<CaptureBrowserSession> {
    const browser = await this.ensureBrowser();
    let context: BrowserContextHandle | undefined;
    try {
      context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor,
        javaScriptEnabled: false,
        serviceWorkers: "block"
      });
      await context.route("**/*", async (route) => {
        if (isBrowserUrlAllowed(route.request().url())) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();
      return { context, page };
    } catch (error) {
      await context?.close().catch(() => undefined);
      throw new BridgeError("browser-capture-failed", "Failed to create an isolated browser page.", undefined, {
        cause: error
      });
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser ?? (await this.pendingLaunch?.catch(() => undefined));
    this.browser = undefined;
    if (browser !== undefined) {
      await browser.close().catch(() => undefined);
    }
  }

  private async launchBrowser(executablePath: string): Promise<BrowserHandle> {
    let browser: BrowserHandle;
    try {
      browser = await this.launcher.launch({
        headless: true,
        args: HARDENED_CHROMIUM_ARGUMENTS,
        executablePath
      });
    } catch (error) {
      throw new BridgeError("browser-start-failed", "Failed to start bundled Chromium.", undefined, {
        cause: error
      });
    }
    if (this.closed) {
      await browser.close().catch(() => undefined);
      throw new BridgeError("browser-unavailable", "The browser manager closed during startup.");
    }
    this.browser = browser;
    browser.on("disconnected", () => {
      if (this.browser === browser) {
        this.browser = undefined;
      }
    });
    return browser;
  }
}

export function getCurrentVsceTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): string | undefined {
  if (platform === "win32" && architecture === "x64") {
    return "win32-x64";
  }
  if (platform === "darwin" && (architecture === "x64" || architecture === "arm64")) {
    return `darwin-${architecture}`;
  }
  if (platform === "linux" && (architecture === "x64" || architecture === "arm64")) {
    return `linux-${architecture}`;
  }
  return undefined;
}

export async function resolveBundledBrowserExecutable(
  browserDirectory: string
): Promise<string | undefined> {
  try {
    const manifestText = await readFile(resolve(browserDirectory, "browser-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText) as Partial<BundledBrowserManifest>;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.target !== getCurrentVsceTarget() ||
      typeof manifest.executablePath !== "string" ||
      manifest.executablePath.length === 0 ||
      isAbsolute(manifest.executablePath)
    ) {
      return undefined;
    }

    const root = resolve(browserDirectory);
    const candidate = resolve(root, manifest.executablePath);
    const fromRoot = relative(root, candidate);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return undefined;
    }
    return (await defaultExecutableExists(candidate)) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function defaultExecutableExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
