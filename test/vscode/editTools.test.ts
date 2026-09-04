import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  documents: [] as Array<Record<string, unknown>>,
  remoteName: undefined as string | undefined,
  uiKind: 1,
  applyCalls: 0,
  appliedOperations: [] as Array<Record<string, unknown>>
}));

vi.mock("vscode", () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number
    ) {}

    public isAfter(other: Position): boolean {
      return this.line > other.line || (this.line === other.line && this.character > other.character);
    }
  }

  class Range {
    public constructor(
      public readonly start: Position,
      public readonly end: Position
    ) {}
  }

  class WorkspaceEdit {
    public readonly operations: Array<Record<string, unknown>> = [];

    public replace(uri: unknown, range: unknown, newText: string): void {
      this.operations.push({ uri, range, newText });
    }
  }

  return {
    UIKind: { Desktop: 1, Web: 2 },
    Position,
    Range,
    WorkspaceEdit,
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
    env: {
      get uiKind() {
        return state.uiKind;
      },
      get remoteName() {
        return state.remoteName;
      }
    },
    workspace: {
      workspaceFolders: [],
      get textDocuments() {
        return state.documents;
      },
      getWorkspaceFolder(uri: { scheme: string }) {
        return uri.scheme === "file" ? {} : undefined;
      },
      openTextDocument() {
        throw new Error("unexpected open");
      },
      applyEdit(edit: WorkspaceEdit) {
        state.applyCalls += 1;
        state.appliedOperations = edit.operations;
        const document = state.documents[0];
        if (document !== undefined && typeof document.version === "number") {
          document.version += 1;
        }
        return Promise.resolve(true);
      }
    }
  };
});

import {
  MAX_EDITS_PER_APPLY,
  MAX_REPLACEMENT_BYTES,
  VsCodeEditService,
  type ApplyEditInput,
  type SerializedTextEdit
} from "../../src/vscode/editTools";

function createDocument(uriText = "untitled:edit", version = 3): Record<string, unknown> {
  const lines = ["first", "second"];
  return {
    uri: { scheme: uriText.split(":", 1)[0], fsPath: "", toString: () => uriText },
    version,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] })
  };
}

function createEdit(newText = "replacement"): SerializedTextEdit {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    },
    newText
  };
}

function createInput(edits: readonly SerializedTextEdit[] = [createEdit()]): ApplyEditInput {
  return { uri: "untitled:edit", expectedVersion: 3, edits };
}

afterEach(() => {
  state.documents = [];
  state.remoteName = undefined;
  state.uiKind = 1;
  state.applyCalls = 0;
  state.appliedOperations = [];
});

describe("VsCodeEditService", () => {
  it("applies edits at the expected version without saving", async () => {
    state.documents = [createDocument()];

    await expect(new VsCodeEditService().applyEdit(createInput())).resolves.toMatchObject({
      previousVersion: 3,
      currentVersion: 4,
      editCount: 1,
      saved: false
    });
    expect(state.applyCalls).toBe(1);
    expect(state.appliedOperations).toHaveLength(1);
  });

  it("rejects a stale expectedVersion before applying anything", async () => {
    state.documents = [createDocument("untitled:edit", 4)];

    await expect(new VsCodeEditService().applyEdit(createInput())).rejects.toMatchObject({
      code: "document-version-conflict",
      details: { currentVersion: 4, expectedVersion: 3 }
    });
    expect(state.applyCalls).toBe(0);
  });

  it("accepts exact edit and replacement limits", async () => {
    state.documents = [createDocument()];
    const edits = Array.from({ length: MAX_EDITS_PER_APPLY }, () => createEdit(""));
    edits[0] = createEdit("a".repeat(MAX_REPLACEMENT_BYTES));

    await expect(new VsCodeEditService().applyEdit(createInput(edits))).resolves.toMatchObject({
      editCount: MAX_EDITS_PER_APPLY,
      replacementBytes: MAX_REPLACEMENT_BYTES
    });
  });

  it("rejects one edit or replacement byte over either limit", async () => {
    state.documents = [createDocument()];
    const tooMany = Array.from({ length: MAX_EDITS_PER_APPLY + 1 }, () => createEdit(""));

    await expect(new VsCodeEditService().applyEdit(createInput(tooMany))).rejects.toMatchObject({
      code: "edit-limit-exceeded"
    });
    await expect(
      new VsCodeEditService().applyEdit(createInput([createEdit("a".repeat(MAX_REPLACEMENT_BYTES + 1))]))
    ).rejects.toMatchObject({ code: "edit-limit-exceeded" });
    expect(state.applyCalls).toBe(0);
  });

  it("rejects invalid UTF-16 positions", async () => {
    state.documents = [createDocument()];
    const invalid = createEdit();
    const input = createInput([
      { ...invalid, range: { ...invalid.range, end: { line: 0, character: 6 } } }
    ]);

    await expect(new VsCodeEditService().applyEdit(input)).rejects.toMatchObject({
      code: "invalid-tool-input"
    });
  });

  it("rejects disabled, remote, and custom-scheme edits", async () => {
    state.documents = [createDocument()];
    await expect(new VsCodeEditService(() => false).applyEdit(createInput())).rejects.toMatchObject({
      details: { reason: "edit-disabled" }
    });

    state.remoteName = "wsl";
    await expect(new VsCodeEditService().applyEdit(createInput())).rejects.toMatchObject({
      details: { reason: "unsupported-environment" }
    });

    state.remoteName = undefined;
    state.documents = [createDocument("custom:edit")];
    await expect(
      new VsCodeEditService().applyEdit({ ...createInput(), uri: "custom:edit" })
    ).rejects.toMatchObject({ code: "workspace-boundary-violation" });
  });
});
