import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  calculateSha256,
  createMfmV14ContractValidators,
  loadAndVerifyMfmV14Snapshot,
  verifyMfmV14Snapshot,
  type MfmV14SourceDescriptor
} from "../../src/contracts/mfmV14";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")) as unknown;
}

async function loadDescriptor(): Promise<MfmV14SourceDescriptor> {
  return (await loadJson("contracts/mfm-v14-source.json")) as MfmV14SourceDescriptor;
}

function expectValid(validator: ValidateFunction, value: unknown): void {
  const valid = validator(value);
  expect(valid, JSON.stringify(validator.errors)).toBe(true);
}

describe("MFM v14 raw source contract", () => {
  const fixtureBytes = Buffer.from("mfm-v14-contract-fixture\n", "utf8");
  const fixtureIntegrity = {
    sourceByteLength: fixtureBytes.byteLength,
    sourceSha256: calculateSha256(fixtureBytes)
  };

  it("accepts bytes matching an integrity descriptor", () => {
    expect(() => verifyMfmV14Snapshot(fixtureIntegrity, fixtureBytes)).not.toThrow();
  });

  it("rejects a one-byte change", () => {
    const changed = Uint8Array.from(fixtureBytes);
    changed[0] ^= 1;

    expect(() => verifyMfmV14Snapshot(fixtureIntegrity, changed)).toThrow(/SHA-256/);
  });

  it.each([
    ["LF to CRLF", (bytes: Uint8Array) => Buffer.from(Buffer.from(bytes).toString("utf8").replaceAll("\n", "\r\n"))],
    ["BOM addition", (bytes: Uint8Array) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
    ["final newline addition", (bytes: Uint8Array) => Buffer.concat([bytes, Buffer.from("\n")])]
  ])("rejects raw-byte mutation: %s", (_name, mutate) => {
    expect(() => verifyMfmV14Snapshot(fixtureIntegrity, mutate(fixtureBytes))).toThrow();
  });

  it("rejects CRLF to LF conversion against a CRLF raw-byte descriptor", () => {
    const crlfBytes = Buffer.from(fixtureBytes.toString("utf8").replaceAll("\n", "\r\n"));
    const crlfIntegrity = {
      sourceByteLength: crlfBytes.byteLength,
      sourceSha256: calculateSha256(crlfBytes)
    };
    const normalizedBytes = Buffer.from(crlfBytes.toString("utf8").replaceAll("\r\n", "\n"));

    expect(() => verifyMfmV14Snapshot(crlfIntegrity, crlfBytes)).not.toThrow();
    expect(() => verifyMfmV14Snapshot(crlfIntegrity, normalizedBytes)).toThrow();
  });

  it("rejects a descriptor byte-length mismatch", () => {
    const changed = { ...fixtureIntegrity, sourceByteLength: fixtureIntegrity.sourceByteLength - 1 };

    expect(() => verifyMfmV14Snapshot(changed, fixtureBytes)).toThrow(/byte length/);
  });

  it("rejects an invalid descriptor hash format", () => {
    const changed = {
      ...fixtureIntegrity,
      sourceSha256: fixtureIntegrity.sourceSha256.toUpperCase()
    };

    expect(() => verifyMfmV14Snapshot(changed, fixtureBytes)).toThrow(/hash format/);
  });

  it("fails when the frozen snapshot is unavailable", async () => {
    const descriptor = await loadDescriptor();
    const changed = { ...descriptor, snapshotPath: "contracts/sources/missing.md" };

    await expect(
      loadAndVerifyMfmV14Snapshot(repositoryRoot, changed as MfmV14SourceDescriptor)
    ).rejects.toThrow();
  });

});

describe("MFM v14 compatibility fixtures", () => {
  it("validates metadata and every success fixture", async () => {
    const schema = await loadJson("contracts/mfm-v14-bridge-compat.schema.json");
    const fixtures = (await loadJson(
      "contracts/mfm-v14-bridge-compat.fixtures.json"
    )) as Record<string, unknown>;
    const validators = createMfmV14ContractValidators(schema as object);

    expectValid(validators.apiMetadata, fixtures.apiMetadata);
    expectValid(validators.parseSuccess, fixtures.parseSuccess);
    expectValid(validators.validationSuccess, fixtures.validationSuccess);
    expectValid(validators.renderSuccess, fixtures.renderSuccess);
    expectValid(validators.profileListSuccess, fixtures.profileListSuccess);
  });

  it("accepts all twelve MFM v14 error codes", async () => {
    const schema = await loadJson("contracts/mfm-v14-bridge-compat.schema.json");
    const fixtures = (await loadJson(
      "contracts/mfm-v14-bridge-compat.fixtures.json"
    )) as { failures: unknown[] };
    const validators = createMfmV14ContractValidators(schema as object);

    expect(fixtures.failures).toHaveLength(12);
    for (const failure of fixtures.failures) {
      expectValid(validators.failure, failure);
    }
    expect(
      fixtures.failures.map(
        (failure) => (failure as { error: { code: string } }).error.code
      )
    ).toEqual([
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
    ]);
  });

  it("contains all twenty known AST variants and the unknown fallback", async () => {
    const fixtures = (await loadJson(
      "contracts/mfm-v14-bridge-compat.fixtures.json"
    )) as { parseSuccess: { value: { nodes: Array<{ type: string }> } } };

    expect(fixtures.parseSuccess.value.nodes.map((node) => node.type)).toEqual([
      "quote",
      "search",
      "blockCode",
      "mathBlock",
      "center",
      "unicodeEmoji",
      "emojiCode",
      "bold",
      "small",
      "italic",
      "strike",
      "inlineCode",
      "mathInline",
      "mention",
      "hashtag",
      "url",
      "link",
      "fn",
      "plain",
      "text",
      "unknown"
    ]);
  });

  it("rejects a failure without error.code", async () => {
    const schema = await loadJson("contracts/mfm-v14-bridge-compat.schema.json");
    const validators = createMfmV14ContractValidators(schema as object);

    expect(validators.failure({ ok: false, error: {} })).toBe(false);
  });

  it("accepts unknown optional fields and unknown AST nodes", async () => {
    const schema = await loadJson("contracts/mfm-v14-bridge-compat.schema.json");
    const fixtures = (await loadJson(
      "contracts/mfm-v14-bridge-compat.fixtures.json"
    )) as Record<string, unknown>;
    const validators = createMfmV14ContractValidators(schema as object);
    const metadata = {
      ...(fixtures.apiMetadata as object),
      futureOptionalField: "ignored"
    };

    expectValid(validators.apiMetadata, metadata);
    expectValid(validators.parseSuccess, fixtures.parseSuccess);
  });

  it("validates the source descriptor against the machine-readable schema", async () => {
    const schema = await loadJson("contracts/mfm-v14-bridge-compat.schema.json");
    const descriptor = await loadDescriptor();
    const validators = createMfmV14ContractValidators(schema as object);

    expectValid(validators.sourceDescriptor, descriptor);
  });
});
