import * as vscode from "vscode";
import type * as z from "zod/v4";
import { BridgeError } from "../../core/errors";
import {
  MFM_EXTENSION_ID,
  type MfmApiResult,
  type MfmCapabilitySummary,
  type MfmExtensionApi,
  type MfmRenderOptions
} from "./contract";
import {
  parseResultSchema,
  profileListResultSchema,
  renderResultSchema,
  sanitizeResult,
  validateMfmApi,
  validationResultSchema
} from "./schemas";

type AdapterState =
  | { readonly kind: "uninitialized" }
  | { readonly kind: "ready"; readonly api: MfmExtensionApi }
  | { readonly kind: "failed"; readonly error: BridgeError; readonly installed: boolean };

export class MfmAdapter {
  private state: AdapterState = { kind: "uninitialized" };
  private pendingActivation: Promise<MfmExtensionApi> | undefined;

  public async getCapabilitySummary(browserAvailable: boolean): Promise<MfmCapabilitySummary> {
    try {
      const api = await this.getApi();
      const environmentSupported = api.environment.supported;
      return {
        extensionId: MFM_EXTENSION_ID,
        installed: true,
        contractCompatible: true,
        adapterState: "ready",
        apiVersion: api.apiVersion,
        environmentSupported,
        parse: environmentSupported,
        validate: environmentSupported,
        renderHtml: environmentSupported,
        listInstanceProfiles: true,
        capturePreview:
          environmentSupported &&
          browserAvailable &&
          api.capabilities.standaloneScripts === false &&
          api.capabilities.embeddedCustomEmoji === true
      };
    } catch (error) {
      const bridgeError = asBridgeError(error);
      const installed = this.state.kind === "failed" ? this.state.installed : false;
      return {
        extensionId: MFM_EXTENSION_ID,
        installed,
        contractCompatible: false,
        adapterState:
          bridgeError.code === "extension-not-installed"
            ? "not-installed"
            : bridgeError.code === "extension-activation-failed"
              ? "activation-failed"
              : "incompatible",
        parse: false,
        validate: false,
        renderHtml: false,
        listInstanceProfiles: false,
        capturePreview: false,
        errorCode: bridgeError.code
      };
    }
  }

  public async parse(text: string, signal?: AbortSignal): Promise<MfmApiResult<unknown>> {
    return this.invoke("parse", signal, (api, token) => api.parse(text, token), parseResultSchema);
  }

  public async validate(text: string, signal?: AbortSignal): Promise<MfmApiResult<unknown>> {
    return this.invoke(
      "validate",
      signal,
      (api, token) => api.validate(text, token),
      validationResultSchema
    );
  }

  public async renderHtml(
    text: string,
    options: MfmRenderOptions,
    signal?: AbortSignal
  ): Promise<MfmApiResult<unknown>> {
    return this.invoke(
      "renderHtml",
      signal,
      (api, token) => api.renderHtml(text, options, token),
      renderResultSchema
    );
  }

  public async renderHtmlWithToken(
    text: string,
    options: MfmRenderOptions,
    token: vscode.CancellationToken
  ): Promise<MfmApiResult<unknown>> {
    return this.invokeWithToken(
      "renderHtml",
      token,
      (api) => api.renderHtml(text, options, token),
      renderResultSchema
    );
  }

  public async listInstanceProfiles(signal?: AbortSignal): Promise<MfmApiResult<unknown>> {
    return this.invoke(
      "listInstanceProfiles",
      signal,
      (api, token) => api.listInstanceProfiles(token),
      profileListResultSchema,
      true
    );
  }

  public async getApi(): Promise<MfmExtensionApi> {
    if (this.state.kind === "ready") {
      return this.state.api;
    }
    if (this.state.kind === "failed") {
      throw this.state.error;
    }
    if (this.pendingActivation !== undefined) {
      return this.pendingActivation;
    }
    this.pendingActivation = this.activate();
    try {
      return await this.pendingActivation;
    } finally {
      this.pendingActivation = undefined;
    }
  }

  private async activate(): Promise<MfmExtensionApi> {
    const extension = vscode.extensions.getExtension<unknown>(MFM_EXTENSION_ID);
    if (extension === undefined) {
      const error = new BridgeError("extension-not-installed", "The MFM extension is not installed.");
      this.state = { kind: "failed", error, installed: false };
      throw error;
    }

    let rawApi: unknown;
    try {
      rawApi = await extension.activate();
    } catch (cause) {
      const error = new BridgeError(
        "extension-activation-failed",
        "The MFM extension failed to activate.",
        undefined,
        { cause }
      );
      this.state = { kind: "failed", error, installed: true };
      throw error;
    }

    try {
      const api = validateMfmApi(rawApi);
      this.state = { kind: "ready", api };
      return api;
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.state = { kind: "failed", error: bridgeError, installed: true };
      throw bridgeError;
    }
  }

  private async invoke<T>(
    operationName: "parse" | "validate" | "renderHtml" | "listInstanceProfiles",
    signal: AbortSignal | undefined,
    operation: (api: MfmExtensionApi, token: vscode.CancellationToken) => Promise<unknown>,
    schema: z.ZodType<T>,
    allowedInUnsupportedEnvironment = false
  ): Promise<MfmApiResult<unknown>> {
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = (): void => cancellation.cancel();
    if (signal?.aborted) {
      cancellation.cancel();
    }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.invokeWithToken(
        operationName,
        cancellation.token,
        (api) => operation(api, cancellation.token),
        schema,
        allowedInUnsupportedEnvironment
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancellation.dispose();
    }
  }

  private async invokeWithToken<T>(
    operationName: "parse" | "validate" | "renderHtml" | "listInstanceProfiles",
    _token: vscode.CancellationToken,
    operation: (api: MfmExtensionApi) => Promise<unknown>,
    schema: z.ZodType<T>,
    allowedInUnsupportedEnvironment = false
  ): Promise<MfmApiResult<unknown>> {
    const api = await this.getApi();
    if (!allowedInUnsupportedEnvironment && !api.environment.supported) {
      return { ok: false, error: { code: "unsupported-environment" } };
    }
    try {
      const rawResult = await operation(api);
      return sanitizeResult(schema, rawResult) as MfmApiResult<unknown>;
    } catch (error) {
      if (error instanceof BridgeError && error.code === "extension-contract-invalid") {
        this.state = { kind: "failed", error, installed: true };
        throw error;
      }
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "internal-error",
        `The MFM ${operationName} operation threw unexpectedly.`,
        undefined,
        { cause: error }
      );
    }
  }
}

function asBridgeError(error: unknown): BridgeError {
  return error instanceof BridgeError
    ? error
    : new BridgeError("extension-contract-invalid", "The MFM extension contract is invalid.", undefined, {
        cause: error
      });
}
