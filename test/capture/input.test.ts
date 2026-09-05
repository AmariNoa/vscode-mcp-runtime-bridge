import { describe, expect, it } from "vitest";
import { normalizeCaptureInput } from "../../src/capture/input";

describe("capture input", () => {
  it("applies the normative defaults", () => {
    expect(normalizeCaptureInput({ text: "hello" })).toEqual({
      source: { kind: "text", text: "hello" },
      theme: "dark",
      animationsEnabled: false,
      loadCustomEmojis: false,
      width: 1_024,
      height: 768,
      deviceScaleFactor: 1,
      format: "png"
    });
  });

  it.each([
    [{}, "neither source"],
    [{ text: "text", uri: "file:///sample.mfm" }, "both sources"],
    [{ text: "text", width: 127 }, "width below"],
    [{ text: "text", width: 4_097 }, "width above"],
    [{ text: "text", width: 128.5 }, "fractional width"],
    [{ text: "text", height: 127 }, "height below"],
    [{ text: "text", height: 4_097 }, "height above"],
    [{ text: "text", deviceScaleFactor: 0.99 }, "scale below"],
    [{ text: "text", deviceScaleFactor: 2.01 }, "scale above"],
    [{ text: "text", deviceScaleFactor: Number.NaN }, "NaN scale"],
    [{ text: "text", deviceScaleFactor: Number.POSITIVE_INFINITY }, "infinite scale"],
    [{ text: "text", format: "jpeg" }, "non-PNG format"]
  ])("rejects invalid input: %s (%s)", (input, _label) => {
    expect(() => normalizeCaptureInput(input as never)).toThrowError(
      expect.objectContaining({ code: "invalid-tool-input" })
    );
  });

  it.each([128, 4_096])("accepts width and height boundary %i", (size) => {
    expect(normalizeCaptureInput({ uri: "file:///sample.mfm", width: size, height: size })).toMatchObject({
      width: size,
      height: size
    });
  });

  it.each([1, 2, 1.5])("accepts deviceScaleFactor %s", (deviceScaleFactor) => {
    expect(normalizeCaptureInput({ text: "text", deviceScaleFactor })).toMatchObject({
      deviceScaleFactor
    });
  });
});
