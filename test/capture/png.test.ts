import { describe, expect, it } from "vitest";
import { MAX_PNG_BYTES, validatePngAndReadDimensions } from "../../src/capture/png";

function pngFixture(width: number, height: number, byteLength = 24): Buffer {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("PNG output policy", () => {
  it.each([MAX_PNG_BYTES - 1, MAX_PNG_BYTES])(
    "accepts a valid PNG at raw byte boundary %i",
    (byteLength) => {
      expect(validatePngAndReadDimensions(pngFixture(2_048, 1_536, byteLength))).toEqual({
        width: 2_048,
        height: 1_536
      });
    }
  );

  it("rejects one raw encoded byte over the limit before base64 conversion", () => {
    expect(() => validatePngAndReadDimensions(pngFixture(1, 1, MAX_PNG_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: "capture-output-too-large" })
    );
  });

  it.each([
    Buffer.alloc(23),
    Buffer.alloc(24),
    pngFixture(0, 1),
    pngFixture(1, 0)
  ])("rejects invalid PNG metadata", (bytes) => {
    expect(() => validatePngAndReadDimensions(bytes)).toThrowError(
      expect.objectContaining({ code: "browser-capture-failed" })
    );
  });
});
