import type { ServerResponse } from "node:http";

export const MAX_TRANSPORT_RESPONSE_BYTES = 32 * 2 ** 20;

export interface BufferedWebResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export async function bufferBoundedTransportResponse(
  response: Response,
  requestId: unknown,
  maximumBytes = MAX_TRANSPORT_RESPONSE_BYTES
): Promise<BufferedWebResponse> {
  const body = await readAtMost(response, maximumBytes);
  if (body !== undefined) {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body
    };
  }

  const replacement = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: "Transport response exceeds the configured byte limit.",
        data: {
          code: "transport-response-too-large",
          maximumBytes
        }
      },
      id: normalizeRequestId(requestId)
    }),
    "utf8"
  );

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return {
    status: 200,
    statusText: "OK",
    headers,
    body: replacement
  };
}

async function readAtMost(response: Response, maximumBytes: number): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumBytes must be a non-negative safe integer.");
  }
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("transport-response-too-large").catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function writeBufferedResponse(
  response: ServerResponse,
  buffered: BufferedWebResponse
): void {
  for (const [name, value] of buffered.headers) {
    if (!isHopByHopHeader(name) && name.toLowerCase() !== "content-length") {
      response.setHeader(name, value);
    }
  }
  response.statusCode = buffered.status;
  response.statusMessage = buffered.statusText;
  response.setHeader("content-length", String(buffered.body.byteLength));
  response.end(buffered.body);
}

function normalizeRequestId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isHopByHopHeader(name: string): boolean {
  return ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(
    name.toLowerCase()
  );
}
