export const BRIDGE_ERROR_CODES = [
  "invalid-tool-input",
  "authentication-failed",
  "server-start-failed",
  "extension-not-installed",
  "extension-activation-failed",
  "extension-contract-invalid",
  "extension-api-version-unsupported",
  "extension-ast-schema-version-unsupported",
  "extension-capability-mismatch",
  "workspace-boundary-violation",
  "document-not-found",
  "document-not-readable",
  "document-too-large",
  "document-version-conflict",
  "edit-limit-exceeded",
  "capture-queue-full",
  "capture-timeout",
  "capture-html-invalid",
  "capture-output-too-large",
  "transport-response-too-large",
  "browser-unavailable",
  "browser-start-failed",
  "browser-capture-failed",
  "internal-error"
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export class BridgeError extends Error {
  public constructor(
    public readonly code: BridgeErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BridgeError";
  }
}
