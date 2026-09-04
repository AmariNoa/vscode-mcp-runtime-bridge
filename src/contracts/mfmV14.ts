import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export const MFM_V14_SOURCE_DOCUMENT =
  "MFM-VSCode-Language-Support_MCP-Integration_Revised-v14.md" as const;
export const MFM_V14_SNAPSHOT_PATH =
  "contracts/sources/MFM-VSCode-Language-Support_MCP-Integration_Revised-v14.md" as const;
export const MFM_V14_SOURCE_SHA256 =
  "fff464e677fb67c1710bc2bf52487e8e48316021795952473bd5c0aa071db3b4" as const;
export const MFM_V14_SOURCE_BYTE_LENGTH = 72_999 as const;

export interface MfmV14SourceDescriptor {
  readonly sourceDocument: typeof MFM_V14_SOURCE_DOCUMENT;
  readonly snapshotPath: typeof MFM_V14_SNAPSHOT_PATH;
  readonly sourceSha256: typeof MFM_V14_SOURCE_SHA256;
  readonly sourceByteLength: typeof MFM_V14_SOURCE_BYTE_LENGTH;
  readonly hashMode: "raw-bytes";
  readonly apiVersion: 1;
  readonly astSchemaVersion: 1;
  readonly mfmJsBaseline: "0.26.0";
}

export interface RawSnapshotIntegrity {
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
}

export interface MfmV14ContractValidators {
  readonly sourceDescriptor: ValidateFunction;
  readonly apiMetadata: ValidateFunction;
  readonly parseSuccess: ValidateFunction;
  readonly validationSuccess: ValidateFunction;
  readonly renderSuccess: ValidateFunction;
  readonly profileListSuccess: ValidateFunction;
  readonly failure: ValidateFunction;
}

export function calculateSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyMfmV14Snapshot(
  descriptor: RawSnapshotIntegrity,
  bytes: Uint8Array
): void {
  if (!/^[0-9a-f]{64}$/.test(descriptor.sourceSha256)) {
    throw new Error("The MFM v14 source hash format is invalid.");
  }
  if (descriptor.sourceByteLength !== bytes.byteLength) {
    throw new Error("The MFM v14 source byte length does not match the descriptor.");
  }
  if (calculateSha256(bytes) !== descriptor.sourceSha256) {
    throw new Error("The MFM v14 source SHA-256 does not match the descriptor.");
  }
}

export async function loadAndVerifyMfmV14Snapshot(
  repositoryRoot: string,
  descriptor: MfmV14SourceDescriptor
): Promise<Uint8Array> {
  const bytes = await readFile(resolve(repositoryRoot, descriptor.snapshotPath));
  verifyMfmV14Snapshot(descriptor, bytes);
  return bytes;
}

export function createMfmV14ContractValidators(
  schema: AnySchema
): MfmV14ContractValidators {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const schemaId = readSchemaId(schema);
  ajv.addSchema(schema, schemaId);

  const compile = (definition: string): ValidateFunction =>
    ajv.compile({ $ref: `${schemaId}#/$defs/${definition}` });

  return {
    sourceDescriptor: compile("sourceDescriptor"),
    apiMetadata: compile("apiMetadata"),
    parseSuccess: compile("parseSuccess"),
    validationSuccess: compile("validationSuccess"),
    renderSuccess: compile("renderSuccess"),
    profileListSuccess: compile("profileListSuccess"),
    failure: compile("failure")
  };
}

function readSchemaId(schema: AnySchema): string {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("$id" in schema) ||
    typeof schema.$id !== "string"
  ) {
    throw new Error("The MFM v14 compatibility schema must define a string $id.");
  }
  return schema.$id;
}
