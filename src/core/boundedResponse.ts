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
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength <= maximumBytes) {
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
