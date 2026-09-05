import { describe, expect, it } from "vitest";
import { isBrowserUrlAllowed, validateStandaloneHtml } from "../../src/capture/htmlPolicy";

describe("standalone HTML policy", () => {
  it.each([99, 100])("accepts HTML at or below an effective %i-byte limit", (maximumBytes) => {
    const html = "a".repeat(99);
    expect(validateStandaloneHtml(html, maximumBytes)).toBe(99);
  });

  it("rejects HTML one byte over the effective extension limit", () => {
    expect(() => validateStandaloneHtml("a".repeat(101), 100)).toThrowError(
      expect.objectContaining({ code: "capture-html-invalid" })
    );
  });

  it.each([
    "<script>location='https://example.invalid'</script>",
    '<link rel="stylesheet" href="data:text/css,body{}">',
    '<img src="https://example.invalid/image.png">',
    '<style>@font-face{src:url(https://example.invalid/font.woff2)}</style>',
    '<style>@import "//example.invalid/styles.css";</style>',
    '<base href="https://example.invalid/">',
    '<iframe src="about:blank"></iframe>'
  ])("rejects unsafe HTML: %s", (html) => {
    expect(() => validateStandaloneHtml(html, 10_000)).toThrowError(
      expect.objectContaining({ code: "capture-html-invalid" })
    );
  });

  it("allows embedded data resources", () => {
    const html = '<style>.emoji{background:url("data:image/png;base64,AA==")}</style><img src="data:image/png;base64,AA==">';
    expect(() => validateStandaloneHtml(html, 10_000)).not.toThrow();
  });
});

describe("browser network policy", () => {
  it.each(["data:image/png;base64,AA==", "about:blank"])("allows %s", (url) => {
    expect(isBrowserUrlAllowed(url)).toBe(true);
  });

  it.each([
    "http://example.invalid",
    "https://example.invalid",
    "ws://example.invalid",
    "wss://example.invalid",
    "ftp://example.invalid/file",
    "file:///etc/passwd",
    "blob:https://example.invalid/id"
  ])("denies %s", (url) => {
    expect(isBrowserUrlAllowed(url)).toBe(false);
  });
});
