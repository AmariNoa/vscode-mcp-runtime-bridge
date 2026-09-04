import type * as vscode from "vscode";

export const MFM_EXTENSION_ID = "noa-amari.mfm-vscode-language-support";

export const MFM_API_ERROR_CODES = [
  "input-too-large",
  "parser-failure",
  "ast-conversion-failure",
  "cancelled",
  "extension-deactivated",
  "instance-profile-not-found",
  "instance-profile-required",
  "instance-profile-not-approved",
  "instance-profile-changed",
  "render-output-too-large",
  "unsupported-environment",
  "internal-error"
] as const;

export type MfmApiErrorCode = (typeof MFM_API_ERROR_CODES)[number];

export interface MfmApiFailure {
  readonly ok: false;
  readonly error: {
    readonly code: MfmApiErrorCode;
    readonly message?: string;
  };
  readonly [key: string]: unknown;
}

export interface MfmApiSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly [key: string]: unknown;
}

export type MfmApiResult<T> = MfmApiSuccess<T> | MfmApiFailure;

export interface MfmExtensionApi {
  readonly apiVersion: 1;
  readonly astSchemaVersion: 1;
  readonly environment: {
    readonly supported: boolean;
    readonly kind: "desktop-local" | "remote" | "web" | "unknown";
    readonly remoteName?: string;
  };
  readonly capabilities: {
    readonly parse: true;
    readonly validate: true;
    readonly renderHtml: true;
    readonly listInstanceProfiles: true;
    readonly capturePreview: false;
    readonly standaloneScripts: false;
    readonly embeddedCustomEmoji: true;
  };
  readonly limits: {
    readonly maxInputCodeUnits: number;
    readonly maxUniqueEmojiRawBytes: number;
    readonly maxDataUrlCodeUnits: number;
    readonly maxEmojiOccurrences: number;
    readonly maxSameEmojiOccurrences: number;
    readonly maxHtmlBytes: number;
  };
  parse(text: string, token?: vscode.CancellationToken): Promise<unknown>;
  validate(text: string, token?: vscode.CancellationToken): Promise<unknown>;
  renderHtml(
    text: string,
    options?: MfmRenderOptions,
    token?: vscode.CancellationToken
  ): Promise<unknown>;
  listInstanceProfiles(token?: vscode.CancellationToken): Promise<unknown>;
}

export interface MfmRenderOptions {
  readonly animationsEnabled?: boolean;
  readonly theme?: "light" | "dark";
  readonly instanceProfileId?: string;
  readonly loadCustomEmojis?: boolean;
}

export interface MfmCapabilitySummary {
  readonly extensionId: typeof MFM_EXTENSION_ID;
  readonly installed: boolean;
  readonly contractCompatible: boolean;
  readonly adapterState: "ready" | "not-installed" | "incompatible" | "activation-failed";
  readonly apiVersion?: number;
  readonly environmentSupported?: boolean;
  readonly parse: boolean;
  readonly validate: boolean;
  readonly renderHtml: boolean;
  readonly listInstanceProfiles: boolean;
  readonly capturePreview: boolean;
  readonly errorCode?: string;
}
