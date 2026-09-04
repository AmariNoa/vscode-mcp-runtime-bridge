import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_SECRET_KEY,
  BearerTokenStore,
  generateAccessToken,
  isAuthorizedBearerHeader,
  type SecretStore
} from "../../src/core/auth";

class MemorySecretStore implements SecretStore {
  public readonly values = new Map<string, string>();
  public stores = 0;

  public get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  public store(key: string, value: string): Promise<void> {
    this.stores += 1;
    this.values.set(key, value);
    return Promise.resolve();
  }
}

describe("BearerTokenStore", () => {
  it("reuses a stored token without rewriting SecretStorage", async () => {
    const secrets = new MemorySecretStore();
    secrets.values.set(ACCESS_TOKEN_SECRET_KEY, "stored-token");
    const store = new BearerTokenStore(secrets);

    await expect(store.getOrCreate()).resolves.toBe("stored-token");
    expect(secrets.stores).toBe(0);
  });

  it("coalesces concurrent token creation", async () => {
    const secrets = new MemorySecretStore();
    const store = new BearerTokenStore(secrets);

    const tokens = await Promise.all([store.getOrCreate(), store.getOrCreate(), store.getOrCreate()]);

    expect(new Set(tokens).size).toBe(1);
    expect(secrets.stores).toBe(1);
  });

  it("replaces the active token when regenerated", async () => {
    const secrets = new MemorySecretStore();
    const store = new BearerTokenStore(secrets);
    const original = await store.getOrCreate();

    await store.regenerate();
    const replacement = await store.getOrCreate();

    expect(replacement).not.toBe(original);
    expect(secrets.values.get(ACCESS_TOKEN_SECRET_KEY)).toBe(replacement);
  });
});

describe("Bearer authorization", () => {
  it("generates a 256-bit base64url token", () => {
    expect(generateAccessToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("accepts only the matching Bearer token", () => {
    expect(isAuthorizedBearerHeader("Bearer expected_token", "expected_token")).toBe(true);
    expect(isAuthorizedBearerHeader("bearer expected_token", "expected_token")).toBe(true);
    expect(isAuthorizedBearerHeader("Bearer wrong_token", "expected_token")).toBe(false);
    expect(isAuthorizedBearerHeader("Bearer expected_token extra", "expected_token")).toBe(false);
    expect(isAuthorizedBearerHeader(undefined, "expected_token")).toBe(false);
  });
});
