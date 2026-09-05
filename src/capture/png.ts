import { BridgeError } from "../core/errors";

// Base64 encoding leaves room for the JSON envelope below common client limits.
export const MAX_PNG_BYTES = 7 * 2 ** 20;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

export function validatePngAndReadDimensions(
  bytes: Uint8Array,
  maximumBytes = MAX_PNG_BYTES
): PngDimensions {
  if (bytes.byteLength > maximumBytes) {
    throw new BridgeError("capture-output-too-large", "PNG output exceeds the configured byte limit.", {
      pngByteLength: bytes.byteLength,
      maximumBytes
    });
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.byteLength < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new BridgeError("browser-capture-failed", "Browser output is not a valid PNG image.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new BridgeError("browser-capture-failed", "PNG dimensions must be positive.");
  }
  return { width, height };
}
