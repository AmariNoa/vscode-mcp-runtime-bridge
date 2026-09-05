import { BridgeError } from "../core/errors";

const NETWORK_SCHEME = /(?:https?|wss?|ftp):/i;
const SCRIPT_ELEMENT = /<script(?:\s|>)/i;
const STYLESHEET_LINK = /<link\b[^>]*\brel\s*=\s*(?:["'][^"']*stylesheet[^"']*["']|stylesheet\b)/i;
const REMOTE_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i;
const CSS_NETWORK_RESOURCE = /(?:url\s*\(\s*["']?\s*(?:https?:|wss?:|ftp:|\/\/)|@import\s+(?:url\s*\()?\s*["']?\s*(?:https?:|\/\/))/i;

export function validateStandaloneHtml(html: string, maximumBytes: number): number {
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maximumBytes) {
    throw new BridgeError("capture-html-invalid", "Rendered HTML exceeds the extension limit.", {
      htmlByteLength: byteLength,
      maximumBytes
    });
  }
  if (SCRIPT_ELEMENT.test(html)) {
    throw invalidHtml("Rendered HTML contains a script element.");
  }
  if (STYLESHEET_LINK.test(html)) {
    throw invalidHtml("Rendered HTML contains an external stylesheet link.");
  }
  if (REMOTE_IMAGE.test(html)) {
    throw invalidHtml("Rendered HTML contains a remote image.");
  }
  if (CSS_NETWORK_RESOURCE.test(html)) {
    throw invalidHtml("Rendered HTML contains a network CSS resource.");
  }
  if (/<base(?:\s|>)/i.test(html) || /<(?:iframe|object|embed)(?:\s|>)/i.test(html)) {
    throw invalidHtml("Rendered HTML contains an unsupported embedding element.");
  }
  return byteLength;
}

export function isBrowserUrlAllowed(url: string): boolean {
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    return scheme === "data:" || scheme === "about:";
  } catch {
    return !NETWORK_SCHEME.test(url) && url === "about:blank";
  }
}

function invalidHtml(message: string): BridgeError {
  return new BridgeError("capture-html-invalid", message);
}
