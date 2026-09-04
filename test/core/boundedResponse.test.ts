import { describe, expect, it } from "vitest";
import {
  MAX_TRANSPORT_RESPONSE_BYTES,
  bufferBoundedTransportResponse
} from "../../src/core/boundedResponse";

describe("bounded transport response", () => {
  it.each([
    ["one byte below", MAX_TRANSPORT_RESPONSE_BYTES - 1],
    ["exactly at", MAX_TRANSPORT_RESPONSE_BYTES]
  ])("accepts a body %s the hard ceiling", async (_label, byteLength) => {
    const body = new Uint8Array(byteLength);
    const result = await bufferBoundedTransportResponse(new Response(body), 17);

    expect(result.body.byteLength).toBe(byteLength);
    expect(result.status).toBe(200);
  });

  it("replaces a body one byte over the ceiling before writing", async () => {
    const body = new Uint8Array(MAX_TRANSPORT_RESPONSE_BYTES + 1);
    const result = await bufferBoundedTransportResponse(new Response(body), "request-1");
    const replacement = JSON.parse(Buffer.from(result.body).toString("utf8")) as {
      error: { data: { code: string; maximumBytes: number } };
      id: string;
    };

    expect(result.body.byteLength).toBeLessThan(MAX_TRANSPORT_RESPONSE_BYTES);
    expect(replacement.error.data).toEqual({
      code: "transport-response-too-large",
      maximumBytes: MAX_TRANSPORT_RESPONSE_BYTES
    });
    expect(replacement.id).toBe("request-1");
  });

  it("counts the complete serialized JSON envelope including base64 and structured content", async () => {
    const envelope = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [{ type: "image", data: Buffer.alloc(24).toString("base64"), mimeType: "image/png" }],
          structuredContent: { notices: ["notice"] }
        }
      }),
      "utf8"
    );
    const accepted = await bufferBoundedTransportResponse(
      new Response(envelope),
      4,
      envelope.byteLength
    );
    const rejected = await bufferBoundedTransportResponse(
      new Response(envelope),
      4,
      envelope.byteLength - 1
    );

    expect(Buffer.from(accepted.body)).toEqual(envelope);
    expect(Buffer.from(rejected.body)).not.toEqual(envelope);
  });
});
