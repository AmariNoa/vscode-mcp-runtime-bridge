import { describe, expect, it } from "vitest";
import { MAX_PNG_BYTES } from "../../src/capture/png";
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

  it("accepts a maximum raw PNG after base64 and metadata below the client ceiling", async () => {
    const pngBase64 = Buffer.alloc(MAX_PNG_BYTES).toString("base64");
    const envelope = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "maximum-capture",
        result: {
          content: [{ type: "image", mimeType: "image/png", data: pngBase64 }],
          structuredContent: {
            mimeType: "image/png",
            pngByteLength: MAX_PNG_BYTES,
            diagnostics: [],
            notices: [],
            externalResources: [],
            knownVisualDifferences: [],
            capture: { format: "png", browserNetworkPolicy: "deny-all" }
          }
        }
      }),
      "utf8"
    );

    expect(envelope.byteLength).toBeLessThan(MAX_TRANSPORT_RESPONSE_BYTES);
    const result = await bufferBoundedTransportResponse(new Response(envelope), "maximum-capture");
    expect(result.body.byteLength).toBe(envelope.byteLength);
  });

  it("replaces an otherwise valid capture when variable metadata crosses the client ceiling", async () => {
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      result: {
        content: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(MAX_PNG_BYTES).toString("base64") }],
        structuredContent: { diagnostics: [{ message: "x".repeat(7 * 2 ** 20) }] }
      }
    });
    const result = await bufferBoundedTransportResponse(new Response(envelope), 91);

    expect(result.body.byteLength).toBeLessThan(1024);
    expect(JSON.parse(Buffer.from(result.body).toString("utf8"))).toMatchObject({
      id: 91,
      error: { data: { code: "transport-response-too-large", maximumBytes: 16777215 } }
    });
  });

  it("cancels a streaming body as soon as the complete response crosses the ceiling", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      }
    });

    const result = await bufferBoundedTransportResponse(new Response(body), "stream", 10);

    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
    expect(JSON.parse(Buffer.from(result.body).toString("utf8"))).toMatchObject({
      error: { data: { code: "transport-response-too-large", maximumBytes: 10 } },
      id: "stream"
    });
  });
});
