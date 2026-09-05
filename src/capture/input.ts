import { BridgeError } from "../core/errors";

export interface CapturePreviewInput {
  readonly text?: string;
  readonly uri?: string;
  readonly theme?: "light" | "dark";
  readonly animationsEnabled?: boolean;
  readonly instanceProfileId?: string;
  readonly loadCustomEmojis?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly deviceScaleFactor?: number;
  readonly format?: "png";
}

export interface NormalizedCapturePreviewInput {
  readonly source: { readonly kind: "text"; readonly text: string } | { readonly kind: "uri"; readonly uri: string };
  readonly theme: "light" | "dark";
  readonly animationsEnabled: boolean;
  readonly instanceProfileId?: string;
  readonly loadCustomEmojis: boolean;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly format: "png";
}

export function normalizeCaptureInput(input: CapturePreviewInput): NormalizedCapturePreviewInput {
  const hasText = typeof input.text === "string";
  const hasUri = typeof input.uri === "string";
  if (hasText === hasUri) {
    throw invalidInput("Exactly one of text or uri is required.");
  }
  const width = input.width ?? 1_024;
  const height = input.height ?? 768;
  const deviceScaleFactor = input.deviceScaleFactor ?? 1;
  if (!Number.isInteger(width) || width < 128 || width > 4_096) {
    throw invalidInput("width must be an integer from 128 through 4096.");
  }
  if (!Number.isInteger(height) || height < 128 || height > 4_096) {
    throw invalidInput("height must be an integer from 128 through 4096.");
  }
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 2) {
    throw invalidInput("deviceScaleFactor must be a finite number from 1 through 2.");
  }
  if (input.format !== undefined && input.format !== "png") {
    throw invalidInput("Only PNG capture is supported.");
  }
  if (input.theme !== undefined && input.theme !== "light" && input.theme !== "dark") {
    throw invalidInput("theme must be light or dark.");
  }
  if (input.animationsEnabled !== undefined && typeof input.animationsEnabled !== "boolean") {
    throw invalidInput("animationsEnabled must be boolean.");
  }
  if (input.loadCustomEmojis !== undefined && typeof input.loadCustomEmojis !== "boolean") {
    throw invalidInput("loadCustomEmojis must be boolean.");
  }
  if (
    input.instanceProfileId !== undefined &&
    (typeof input.instanceProfileId !== "string" || input.instanceProfileId.length === 0)
  ) {
    throw invalidInput("instanceProfileId must be a non-empty string.");
  }

  return {
    source: hasText
      ? { kind: "text", text: input.text as string }
      : { kind: "uri", uri: input.uri as string },
    theme: input.theme ?? "dark",
    animationsEnabled: input.animationsEnabled ?? false,
    ...(input.instanceProfileId === undefined
      ? {}
      : { instanceProfileId: input.instanceProfileId }),
    loadCustomEmojis: input.loadCustomEmojis ?? false,
    width,
    height,
    deviceScaleFactor,
    format: "png"
  };
}

function invalidInput(message: string): BridgeError {
  return new BridgeError("invalid-tool-input", message);
}
