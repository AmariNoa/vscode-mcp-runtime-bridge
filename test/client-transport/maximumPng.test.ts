import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_PNG_BYTES, validatePngAndReadDimensions } from "../../src/capture/png";
import { createMaximumPng, FIXTURE_SIDE_PIXELS } from "./maximumPng";

describe("maximum PNG client transport fixture", () => {
  it("creates a decodable four-quadrant PNG at the raw capture limit", () => {
    const png = createMaximumPng();
    const chunks = readChunks(png);
    const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));

    expect(png.byteLength).toBe(MAX_PNG_BYTES);
    expect(validatePngAndReadDimensions(png)).toEqual({ width: FIXTURE_SIDE_PIXELS, height: FIXTURE_SIDE_PIXELS });
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "tEXt", "IEND"]);
    const decoded = inflateSync(idat);
    const stride = 1 + FIXTURE_SIDE_PIXELS * 3;
    expect(decoded.byteLength).toBe(stride * FIXTURE_SIDE_PIXELS);
    const pixel = (x: number, y: number) => [...decoded.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
    expect(pixel(0, 0)).toEqual([255, 0, 0]);
    expect(pixel(FIXTURE_SIDE_PIXELS - 1, 0)).toEqual([0, 255, 0]);
    expect(pixel(0, FIXTURE_SIDE_PIXELS - 1)).toEqual([0, 0, 255]);
    expect(pixel(FIXTURE_SIDE_PIXELS - 1, FIXTURE_SIDE_PIXELS - 1)).toEqual([255, 255, 0]);
  });
});

interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
}

function readChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    chunks.push({ type, data: png.subarray(dataStart, dataStart + length) });
    offset = dataStart + length + 4;
  }
  expect(offset).toBe(png.byteLength);
  return chunks;
}
