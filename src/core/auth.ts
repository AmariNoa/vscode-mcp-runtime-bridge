import { randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_TOKEN_SECRET_KEY = "vscodeMcp.accessToken.v1";
const ACCESS_TOKEN_BYTES = 32;

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

export class BearerTokenStore {
  private currentToken: string | undefined;
  private pendingToken: Promise<string> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly secrets: SecretStore) {}

  public async getOrCreate(): Promise<string> {
    if (this.currentToken !== undefined) {
      return this.currentToken;
    }
    if (this.pendingToken !== undefined) {
      return this.pendingToken;
    }

    const operation = this.operationQueue.then(() => this.loadOrCreate());
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    this.pendingToken = operation;
    try {
      this.currentToken = await this.pendingToken;
      return this.currentToken;
    } finally {
      this.pendingToken = undefined;
    }
  }

  public async regenerate(): Promise<void> {
    const operation = this.operationQueue.then(async () => {
      const token = generateAccessToken();
      await this.secrets.store(ACCESS_TOKEN_SECRET_KEY, token);
      this.currentToken = token;
    });
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  private async loadOrCreate(): Promise<string> {
    if (this.currentToken !== undefined) {
      return this.currentToken;
    }
    const stored = await this.secrets.get(ACCESS_TOKEN_SECRET_KEY);
    if (stored !== undefined && stored.length > 0) {
      return stored;
    }

    const token = generateAccessToken();
    await this.secrets.store(ACCESS_TOKEN_SECRET_KEY, token);
    return token;
  }
}

export function generateAccessToken(): string {
  return randomBytes(ACCESS_TOKEN_BYTES).toString("base64url");
}

export function isAuthorizedBearerHeader(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  const suppliedToken = readBearerToken(authorizationHeader);
  if (suppliedToken === undefined) {
    return false;
  }

  const suppliedBytes = Buffer.from(suppliedToken, "utf8");
  const expectedBytes = Buffer.from(expectedToken, "utf8");
  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorizationHeader);
  return match?.[1];
}
