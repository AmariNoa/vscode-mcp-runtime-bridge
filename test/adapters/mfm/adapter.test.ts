import { afterEach, describe, expect, it, vi } from "vitest";

const extensionState = vi.hoisted(() => ({
  extension: undefined as undefined | { activate: () => Promise<unknown> }
}));

vi.mock("vscode", () => {
  class CancellationTokenSource {
    public readonly token = { isCancellationRequested: false };

    public cancel(): void {
      this.token.isCancellationRequested = true;
    }

    public dispose(): void {}
  }

  return {
    CancellationTokenSource,
    extensions: {
      getExtension: () => extensionState.extension
    }
  };
});

import { MfmAdapter } from "../../../src/adapters/mfm/adapter";

function createValidApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    astSchemaVersion: 1,
    environment: { supported: true, kind: "desktop-local" },
    capabilities: {
      parse: true,
      validate: true,
      renderHtml: true,
      listInstanceProfiles: true,
      capturePreview: false,
      standaloneScripts: false,
      embeddedCustomEmoji: true
    },
    limits: {
      maxInputCodeUnits: 16_384,
      maxUniqueEmojiRawBytes: 8_388_608,
      maxDataUrlCodeUnits: 12_582_912,
      maxEmojiOccurrences: 512,
      maxSameEmojiOccurrences: 32,
      maxHtmlBytes: 16_777_216
    },
    parse: () => Promise.resolve({ ok: true, value: { astSchemaVersion: 1, nodes: [] } }),
    validate: () => Promise.resolve({ ok: true, value: { valid: true, diagnostics: [] } }),
    renderHtml: () =>
      Promise.resolve({
        ok: true,
        value: { html: "<!doctype html>", diagnostics: [], notices: [], externalResources: [] }
      }),
    listInstanceProfiles: () => Promise.resolve({ ok: true, value: [] }),
    ...overrides
  };
}

function installApi(api: Record<string, unknown>): void {
  extensionState.extension = { activate: () => Promise.resolve(api) };
}

afterEach(() => {
  extensionState.extension = undefined;
});

describe("MfmAdapter contract activation", () => {
  it("reports an absent extension without claiming compatibility", async () => {
    await expect(new MfmAdapter().getCapabilitySummary(false)).resolves.toMatchObject({
      installed: false,
      contractCompatible: false,
      adapterState: "not-installed",
      errorCode: "extension-not-installed"
    });
  });

  it("reports activation failures distinctly", async () => {
    extensionState.extension = { activate: () => Promise.reject(new Error("activation failed")) };

    await expect(new MfmAdapter().getCapabilitySummary(false)).resolves.toMatchObject({
      installed: true,
      adapterState: "activation-failed",
      errorCode: "extension-activation-failed"
    });
  });

  it.each([
    ["apiVersion", { apiVersion: 2 }, "extension-api-version-unsupported"],
    ["astSchemaVersion", { astSchemaVersion: 2 }, "extension-ast-schema-version-unsupported"],
    ["limits", { limits: { maxInputCodeUnits: 0 } }, "extension-contract-invalid"],
    ["environment", { environment: { supported: "yes" } }, "extension-contract-invalid"]
  ])("rejects incompatible %s metadata", async (_name, overrides, errorCode) => {
    installApi(createValidApi(overrides));

    await expect(new MfmAdapter().getCapabilitySummary(false)).resolves.toMatchObject({
      installed: true,
      contractCompatible: false,
      adapterState: "incompatible",
      errorCode
    });
  });

  it.each([
    ["parse", false],
    ["validate", false],
    ["renderHtml", false],
    ["listInstanceProfiles", false],
    ["capturePreview", true],
    ["standaloneScripts", true],
    ["embeddedCustomEmoji", false]
  ])("rejects a literal capability mismatch for %s", async (name, value) => {
    const api = createValidApi();
    api.capabilities = { ...(api.capabilities as object), [name]: value };
    installApi(api);

    await expect(new MfmAdapter().getCapabilitySummary(false)).resolves.toMatchObject({
      contractCompatible: false,
      errorCode: "extension-capability-mismatch"
    });
  });

  it("coalesces concurrent activation and reports effective availability", async () => {
    let activations = 0;
    extensionState.extension = {
      activate: async () => {
        activations += 1;
        await Promise.resolve();
        return createValidApi();
      }
    };
    const adapter = new MfmAdapter();

    const [withoutBrowser, withBrowser] = await Promise.all([
      adapter.getCapabilitySummary(false),
      adapter.getCapabilitySummary(true)
    ]);

    expect(activations).toBe(1);
    expect(withoutBrowser).toMatchObject({
      contractCompatible: true,
      parse: true,
      listInstanceProfiles: true,
      capturePreview: false
    });
    expect(withBrowser.capturePreview).toBe(true);
  });

  it("allows profile listing but not parse in an unsupported environment", async () => {
    let parseCalls = 0;
    let profileCalls = 0;
    installApi(
      createValidApi({
        environment: { supported: false, kind: "remote", remoteName: "ssh" },
        parse: () => {
          parseCalls += 1;
          return Promise.resolve({ ok: true, value: { astSchemaVersion: 1, nodes: [] } });
        },
        listInstanceProfiles: () => {
          profileCalls += 1;
          return Promise.resolve({ ok: true, value: [] });
        }
      })
    );
    const adapter = new MfmAdapter();

    await expect(adapter.parse("text")).resolves.toEqual({
      ok: false,
      error: { code: "unsupported-environment" }
    });
    await expect(adapter.listInstanceProfiles()).resolves.toEqual({ ok: true, value: [] });
    expect(parseCalls).toBe(0);
    expect(profileCalls).toBe(1);
  });

  it("passes caller cancellation to the MFM token and keeps it alive through completion", async () => {
    const controller = new AbortController();
    controller.abort();
    installApi(
      createValidApi({
        parse: (_text: string, token: { isCancellationRequested: boolean }) =>
          Promise.resolve(
            token.isCancellationRequested
              ? { ok: false, error: { code: "cancelled" } }
              : { ok: true, value: { astSchemaVersion: 1, nodes: [] } }
          )
      })
    );

    await expect(new MfmAdapter().parse("text", controller.signal)).resolves.toEqual({
      ok: false,
      error: { code: "cancelled" }
    });
  });

  it("sanitizes unknown failure fields before returning them", async () => {
    installApi(
      createValidApi({
        parse: () =>
          Promise.resolve({
            ok: false,
            error: { code: "parser-failure", message: "invalid", privateDetail: "remove" },
            privateEnvelope: "remove"
          })
      })
    );

    await expect(new MfmAdapter().parse("text")).resolves.toEqual({
      ok: false,
      error: { code: "parser-failure", message: "invalid" }
    });
  });

  it("invalidates the whole adapter after an invalid method result", async () => {
    installApi(createValidApi({ parse: () => Promise.resolve({ ok: false, error: {} }) }));
    const adapter = new MfmAdapter();

    await expect(adapter.parse("text")).rejects.toMatchObject({
      code: "extension-contract-invalid"
    });
    await expect(adapter.getCapabilitySummary(false)).resolves.toMatchObject({
      contractCompatible: false,
      adapterState: "incompatible",
      errorCode: "extension-contract-invalid"
    });
  });
});
