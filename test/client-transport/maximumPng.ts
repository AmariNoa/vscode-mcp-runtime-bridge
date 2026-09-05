import { deflateSync } from "node:zlib";
import { MAX_PNG_BYTES } from "../../src/capture/png";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = createCrcTable();
export const FIXTURE_SIDE_PIXELS = 1536;

export function createMaximumPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(FIXTURE_SIDE_PIXELS, 0);
  ihdr.writeUInt32BE(FIXTURE_SIDE_PIXELS, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const stride = 1 + FIXTURE_SIDE_PIXELS * 3;
  const scanlines = Buffer.alloc(stride * FIXTURE_SIDE_PIXELS);
  for (let y = 0; y < FIXTURE_SIDE_PIXELS; y += 1) {
    for (let x = 0; x < FIXTURE_SIDE_PIXELS; x += 1) {
      const offset = y * stride + 1 + x * 3;
      // Four recognizable solid quadrants, encoded without compression.
      const right = x >= FIXTURE_SIDE_PIXELS / 2;
      const bottom = y >= FIXTURE_SIDE_PIXELS / 2;
      scanlines[offset] = right ? (bottom ? 255 : 0) : (bottom ? 0 : 255);
      scanlines[offset + 1] = right ? 255 : 0;
      scanlines[offset + 2] = bottom && !right ? 255 : 0;
    }
  }
  const idat = deflateSync(scanlines, { level: 0 });
  const fixedBytes =
    PNG_SIGNATURE.byteLength +
    pngChunkByteLength(ihdr) +
    pngChunkByteLength(idat) +
    pngChunkByteLength(Buffer.alloc(0)) +
    12;
  const padding = Buffer.alloc(MAX_PNG_BYTES - fixedBytes, 0x61);
  padding.write("padding", 0, "latin1");
  padding[7] = 0;

  const png = Buffer.concat([
    PNG_SIGNATURE,
    createChunk("IHDR", ihdr),
    createChunk("IDAT", idat),
    createChunk("tEXt", padding),
    createChunk("IEND", Buffer.alloc(0))
  ]);
  if (png.byteLength !== MAX_PNG_BYTES) {
    throw new Error(`Maximum PNG fixture has an unexpected length: ${png.byteLength}.`);
  }
  return png;
}

function pngChunkByteLength(data: Uint8Array): number {
  return 12 + data.byteLength;
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(typeBytes, data), 8 + data.byteLength);
  return chunk;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(...buffers: readonly Buffer[]): number {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
