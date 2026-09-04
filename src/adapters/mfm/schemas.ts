import * as z from "zod/v4";
import { MFM_API_ERROR_CODES, type MfmExtensionApi } from "./contract";
import { BridgeError } from "../../core/errors";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const environmentSchema = z
  .object({
    supported: z.boolean(),
    kind: z.enum(["desktop-local", "remote", "web", "unknown"]),
    remoteName: z.string().optional()
  })
  .passthrough();
const limitsSchema = z
  .object({
    maxInputCodeUnits: positiveSafeInteger,
    maxUniqueEmojiRawBytes: positiveSafeInteger,
    maxDataUrlCodeUnits: positiveSafeInteger,
    maxEmojiOccurrences: positiveSafeInteger,
    maxSameEmojiOccurrences: positiveSafeInteger,
    maxHtmlBytes: positiveSafeInteger
  })
  .passthrough();
const capabilitiesSchema = z
  .object({
    parse: z.literal(true),
    validate: z.literal(true),
    renderHtml: z.literal(true),
    listInstanceProfiles: z.literal(true),
    capturePreview: z.literal(false),
    standaloneScripts: z.literal(false),
    embeddedCustomEmoji: z.literal(true)
  })
  .passthrough();

const errorCodeSchema = z.enum(MFM_API_ERROR_CODES);
const failureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().optional()
      })
      .passthrough()
  })
  .passthrough();

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);
const astNodeSchema = z.object({ type: z.string().min(1) }).catchall(jsonValueSchema);
const diagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning", "information"]),
    code: z.enum(["unclosed-function", "unknown-function", "unknown-argument", "invalid-argument-value"]),
    message: z.string(),
    range: z
      .object({
        start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
        end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })
      })
      .optional()
  })
  .passthrough();

export const parseResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.object({ astSchemaVersion: z.literal(1), nodes: z.array(astNodeSchema) }).passthrough()
  }),
  failureSchema
]);

export const validationResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.object({ valid: z.boolean(), diagnostics: z.array(diagnosticSchema) }).passthrough()
  }),
  failureSchema
]);

const renderNoticeSchema = z
  .object({
    code: z.enum([
      "custom-emoji-fetch-failed",
      "custom-emoji-metadata-rejected",
      "custom-emoji-image-rejected",
      "custom-emoji-resource-deadline",
      "custom-emoji-queue-limit",
      "custom-emoji-output-limit"
    ]),
    count: z.number().int().nonnegative(),
    message: z.string()
  })
  .passthrough();
const externalResourceSchema = z
  .object({
    kind: z.literal("custom-emoji"),
    resourceOrigin: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    rawByteLength: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .passthrough();

export const renderResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z
      .object({
        html: z.string(),
        diagnostics: z.array(diagnosticSchema),
        notices: z.array(renderNoticeSchema),
        externalResources: z.array(externalResourceSchema)
      })
      .passthrough()
  }),
  failureSchema
]);

export const profileListResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          origin: z.string(),
          approvedResourceOrigins: z.array(z.string())
        })
        .passthrough()
    )
  }),
  failureSchema
]);

export function validateMfmApi(value: unknown): MfmExtensionApi {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError("extension-contract-invalid", "The MFM extension API is not an object.");
  }
  const candidate = value as Record<string, unknown>;
  for (const method of ["parse", "validate", "renderHtml", "listInstanceProfiles"] as const) {
    if (typeof candidate[method] !== "function") {
      throw new BridgeError("extension-contract-invalid", `The MFM API method ${method} is missing.`);
    }
  }
  if (candidate.apiVersion !== 1) {
    throw new BridgeError(
      "extension-api-version-unsupported",
      "The MFM extension API version is unsupported."
    );
  }
  if (candidate.astSchemaVersion !== 1) {
    throw new BridgeError(
      "extension-ast-schema-version-unsupported",
      "The MFM AST schema version is unsupported."
    );
  }
  if (!capabilitiesSchema.safeParse(candidate.capabilities).success) {
    throw new BridgeError(
      "extension-capability-mismatch",
      "The MFM extension capabilities do not match the v14 contract."
    );
  }
  if (!limitsSchema.safeParse(candidate.limits).success) {
    throw new BridgeError("extension-contract-invalid", "The MFM extension limits are invalid.");
  }
  if (!environmentSchema.safeParse(candidate.environment).success) {
    throw new BridgeError("extension-contract-invalid", "The MFM extension environment is invalid.");
  }
  return value as MfmExtensionApi;
}

export function sanitizeResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("extension-contract-invalid", "The MFM extension returned an invalid result.");
  }
  if (isFailure(parsed.data)) {
    return {
      ok: false,
      error: {
        code: parsed.data.error.code,
        ...(parsed.data.error.message === undefined ? {} : { message: parsed.data.error.message })
      }
    } as T;
  }
  return parsed.data;
}

function isFailure(value: unknown): value is z.infer<typeof failureSchema> {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}
