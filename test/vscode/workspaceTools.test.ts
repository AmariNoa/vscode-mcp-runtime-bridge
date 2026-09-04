import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  documents: [] as Array<Record<string, unknown>>,
  diagnostics: [] as Array<[Record<string, unknown>, Array<Record<string, unknown>>]>,
  remoteName: undefined as string | undefined,
  uiKind: 1,
  activeDocument: undefined as Record<string, unknown> | undefined
}));

vi.mock("vscode", () => ({
  UIKind: { Desktop: 1, Web: 2 },
  EndOfLine: { LF: 1, CRLF: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: {
    parse(value: string) {
      const separator = value.indexOf(":");
      if (separator <= 0) {
        throw new Error("invalid URI");
      }
      return {
        scheme: value.slice(0, separator),
        fsPath: "",
        toString: () => value
      };
    }
  },
  version: "1.90.0-test",
  env: {
    get uiKind() {
      return state.uiKind;
    },
    get remoteName() {
      return state.remoteName;
    }
  },
  window: {
    get activeTextEditor() {
      return state.activeDocument === undefined ? undefined : { document: state.activeDocument };
    }
  },
  workspace: {
    workspaceFolders: [],
    workspaceFile: undefined,
    get textDocuments() {
      return state.documents;
    },
    getWorkspaceFolder(uri: { scheme: string }) {
      return uri.scheme === "file" ? {} : undefined;
    },
    openTextDocument() {
      throw new Error("unexpected open");
    }
  },
  languages: {
    getDiagnostics() {
      return state.diagnostics;
    }
  }
}));

import {
  MAX_DOCUMENT_BYTES,
  MAX_WORKSPACE_DIAGNOSTICS,
  VsCodeToolsService
} from "../../src/vscode/workspaceTools";

function createDocument(uriText: string, text: string): Record<string, unknown> {
  return {
    uri: { scheme: uriText.split(":", 1)[0], fsPath: "", toString: () => uriText },
    languageId: "mfm",
    isDirty: true,
    version: 7,
    isUntitled: uriText.startsWith("untitled:"),
    eol: 1,
    getText: () => text
  };
}

afterEach(() => {
  state.documents = [];
  state.diagnostics = [];
  state.remoteName = undefined;
  state.uiKind = 1;
  state.activeDocument = undefined;
});

describe("VsCodeToolsService", () => {
  it("includes asynchronously evaluated extension capabilities", async () => {
    const service = new VsCodeToolsService(() =>
      Promise.resolve({ mfm: { installed: true, contractCompatible: true } })
    );

    await expect(service.getCapabilities()).resolves.toMatchObject({
      supportedEnvironment: true,
      extensions: { mfm: { installed: true, contractCompatible: true } }
    });
  });

  it("reports active editor and supported desktop metadata", () => {
    const document = createDocument("untitled:active", "draft");
    state.documents = [document];
    state.activeDocument = document;

    expect(new VsCodeToolsService().getWorkspaceInfo("session-1")).toMatchObject({
      sessionId: "session-1",
      vscodeVersion: "1.90.0-test",
      remoteName: null,
      activeEditorUri: "untitled:active",
      activeEditorLanguageId: "mfm",
      supportedEnvironment: true
    });
  });

  it("returns current unsaved text and accepts the exact 4 MiB boundary", async () => {
    const text = "a".repeat(MAX_DOCUMENT_BYTES);
    state.documents = [createDocument("untitled:boundary", text)];

    await expect(new VsCodeToolsService().readDocument("untitled:boundary")).resolves.toMatchObject({
      dirty: true,
      version: 7,
      byteLength: MAX_DOCUMENT_BYTES,
      text
    });
  });

  it("rejects a document one byte over 4 MiB", async () => {
    state.documents = [createDocument("untitled:large", "a".repeat(MAX_DOCUMENT_BYTES + 1))];

    await expect(new VsCodeToolsService().readDocument("untitled:large")).rejects.toMatchObject({
      code: "document-too-large"
    });
  });

  it("rejects binary and unopened custom-scheme documents", async () => {
    state.documents = [createDocument("custom:binary", "prefix\0suffix")];
    const service = new VsCodeToolsService();

    await expect(service.readDocument("custom:binary")).rejects.toMatchObject({
      code: "document-not-readable"
    });
    await expect(service.readDocument("custom:missing")).rejects.toMatchObject({
      code: "workspace-boundary-violation"
    });
  });

  it("disables document access in remote environments", async () => {
    state.remoteName = "ssh-remote";
    state.documents = [createDocument("untitled:remote", "text")];

    await expect(new VsCodeToolsService().readDocument("untitled:remote")).rejects.toMatchObject({
      code: "document-not-readable",
      details: { reason: "unsupported-environment" }
    });
  });

  it("caps workspace diagnostics at 5000 entries", () => {
    const uri = { scheme: "file", fsPath: "", toString: () => "file:///workspace/file.mfm" };
    const diagnostic = {
      severity: 0,
      message: "problem",
      range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } }
    };
    state.diagnostics = [[uri, Array.from({ length: MAX_WORKSPACE_DIAGNOSTICS + 1 }, () => diagnostic)]];

    const result = new VsCodeToolsService().getDiagnostics() as {
      count: number;
      truncated: boolean;
      diagnostics: unknown[];
    };
    expect(result).toMatchObject({
      count: MAX_WORKSPACE_DIAGNOSTICS,
      truncated: true
    });
    expect(result.diagnostics).toHaveLength(MAX_WORKSPACE_DIAGNOSTICS);
  });
});
