import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserManager,
  getCurrentVsceTarget,
  resolveBundledBrowserExecutable,
  type BrowserContextHandle,
  type BrowserHandle,
  type BrowserLauncher
} from "../../src/capture/browserManager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function createBrowser(): {
  browser: BrowserHandle;
  context: BrowserContextHandle;
  routeHandler: { current?: Parameters<BrowserContextHandle["route"]>[1] };
  disconnect: () => void;
  browserClose: ReturnType<typeof vi.fn>;
  contextClose: ReturnType<typeof vi.fn>;
} {
  let disconnectListener: (() => void) | undefined;
  const routeHandler: { current?: Parameters<BrowserContextHandle["route"]>[1] } = {};
  const contextClose = vi.fn(() => Promise.resolve());
  const context: BrowserContextHandle = {
    route: (_url, handler) => {
      routeHandler.current = handler;
      return Promise.resolve();
    },
    newPage: () =>
      Promise.resolve({
        setContent: () => Promise.resolve(),
        evaluate: () => Promise.resolve(),
        screenshot: () => Promise.resolve(Buffer.alloc(24)),
        close: () => Promise.resolve()
      }),
    close: contextClose
  };
  const browserClose = vi.fn(() => Promise.resolve());
  const browser: BrowserHandle = {
    isConnected: () => true,
    newContext: () => Promise.resolve(context),
    close: browserClose,
    on: (_event, listener) => {
      disconnectListener = listener;
    }
  };
  return {
    browser,
    context,
    routeHandler,
    disconnect: () => disconnectListener?.(),
    browserClose,
    contextClose
  };
}

describe("BrowserManager", () => {
  it("reports a missing bundled executable without launching", async () => {
    const launch = vi.fn<BrowserLauncher["launch"]>();
    const manager = new BrowserManager({
      launcher: { executablePath: () => "missing", launch },
      executableExists: () => Promise.resolve(false)
    });

    await expect(manager.ensureBrowser()).rejects.toMatchObject({ code: "browser-unavailable" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("coalesces lazy launch and reuses the connected browser", async () => {
    const fake = createBrowser();
    const launch = vi.fn(() => Promise.resolve(fake.browser));
    const manager = new BrowserManager({
      launcher: { executablePath: () => "available", launch },
      executableExists: () => Promise.resolve(true)
    });

    const [first, second] = await Promise.all([manager.ensureBrowser(), manager.ensureBrowser()]);
    const third = await manager.ensureBrowser();

    expect(first).toBe(fake.browser);
    expect(second).toBe(fake.browser);
    expect(third).toBe(fake.browser);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: "available" }));
  });

  it("creates an isolated JavaScript-disabled context with deny-all routing", async () => {
    const fake = createBrowser();
    const launch = vi.fn(() => Promise.resolve(fake.browser));
    const manager = new BrowserManager({
      launcher: { executablePath: () => "available", launch },
      executableExists: () => Promise.resolve(true)
    });
    const newContext = vi.spyOn(fake.browser, "newContext");

    await manager.createSession(800, 600, 2);

    expect(newContext).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
      javaScriptEnabled: false,
      serviceWorkers: "block"
    });
    const continueRoute = vi.fn(() => Promise.resolve());
    const abortRoute = vi.fn(() => Promise.resolve());
    await fake.routeHandler.current!({
      request: () => ({ url: () => "data:image/png;base64,AA==" }),
      continue: continueRoute,
      abort: abortRoute
    });
    await fake.routeHandler.current!({
      request: () => ({ url: () => "https://example.invalid/image.png" }),
      continue: continueRoute,
      abort: abortRoute
    });
    expect(continueRoute).toHaveBeenCalledTimes(1);
    expect(abortRoute).toHaveBeenCalledWith("blockedbyclient");
  });

  it("recreates Chromium after a disconnect", async () => {
    const first = createBrowser();
    const second = createBrowser();
    const launch = vi
      .fn<BrowserLauncher["launch"]>()
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser);
    const manager = new BrowserManager({
      launcher: { executablePath: () => "available", launch },
      executableExists: () => Promise.resolve(true)
    });
    await manager.ensureBrowser();

    first.disconnect();

    await expect(manager.ensureBrowser()).resolves.toBe(second.browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("closes the shared browser and rejects future startup", async () => {
    const fake = createBrowser();
    const manager = new BrowserManager({
      launcher: {
        executablePath: () => "available",
        launch: () => Promise.resolve(fake.browser)
      },
      executableExists: () => Promise.resolve(true)
    });
    await manager.ensureBrowser();

    await manager.close();

    expect(fake.browserClose).toHaveBeenCalledTimes(1);
    await expect(manager.ensureBrowser()).rejects.toMatchObject({ code: "browser-unavailable" });
  });

  it("closes a partially created context when page creation fails", async () => {
    const fake = createBrowser();
    vi.spyOn(fake.context, "newPage").mockRejectedValue(new Error("page failed"));
    const manager = new BrowserManager({
      launcher: {
        executablePath: () => "available",
        launch: () => Promise.resolve(fake.browser)
      },
      executableExists: () => Promise.resolve(true)
    });

    await expect(manager.createSession(800, 600, 1)).rejects.toMatchObject({
      code: "browser-capture-failed"
    });
    expect(fake.contextClose).toHaveBeenCalledTimes(1);
  });

  it("maps only the reviewed native package targets", () => {
    expect(getCurrentVsceTarget("win32", "x64")).toBe("win32-x64");
    expect(getCurrentVsceTarget("win32", "arm64")).toBeUndefined();
    expect(getCurrentVsceTarget("darwin", "x64")).toBe("darwin-x64");
    expect(getCurrentVsceTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(getCurrentVsceTarget("linux", "x64")).toBe("linux-x64");
    expect(getCurrentVsceTarget("linux", "arm64")).toBe("linux-arm64");
  });

  it("resolves a platform-matching executable inside the extension-owned browser directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vscode-mcp-browser-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "chromium", "browser.exe");
    await mkdir(join(directory, "chromium"));
    await writeFile(executable, "browser");
    await writeFile(
      join(directory, "browser-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: getCurrentVsceTarget(),
        executablePath: "chromium/browser.exe"
      })
    );

    await expect(resolveBundledBrowserExecutable(directory)).resolves.toBe(executable);
  });

  it("rejects mismatched and escaping bundled-browser manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vscode-mcp-browser-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "browser-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, target: "unsupported-target", executablePath: "browser.exe" })
    );
    await expect(resolveBundledBrowserExecutable(directory)).resolves.toBeUndefined();

    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        target: getCurrentVsceTarget(),
        executablePath: "../browser.exe"
      })
    );
    await expect(resolveBundledBrowserExecutable(directory)).resolves.toBeUndefined();
  });
});
