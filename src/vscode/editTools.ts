import * as vscode from "vscode";
import { BridgeError } from "../core/errors";
import { assertRealPathInsideWorkspace } from "../security/uriPolicy";
import { isSupportedEnvironment } from "./workspaceTools";

export const MAX_EDITS_PER_APPLY = 1_000;
export const MAX_REPLACEMENT_BYTES = 4 * 2 ** 20;

export interface SerializedPosition {
  readonly line: number;
  readonly character: number;
}

export interface SerializedRange {
  readonly start: SerializedPosition;
  readonly end: SerializedPosition;
}

export interface SerializedTextEdit {
  readonly range: SerializedRange;
  readonly newText: string;
}

export interface ApplyEditInput {
  readonly uri: string;
  readonly expectedVersion: number;
  readonly edits: readonly SerializedTextEdit[];
}

export class VsCodeEditService {
  public constructor(private readonly isEditAllowed: () => boolean = () => true) {}

  public async applyEdit(input: ApplyEditInput): Promise<Record<string, unknown>> {
    if (!this.isEditAllowed()) {
      throw new BridgeError("workspace-boundary-violation", "Workspace editing is disabled.", {
        reason: "edit-disabled"
      });
    }
    validateEditCount(input.edits);
    const replacementBytes = validateReplacementBytes(input.edits);
    const uri = parseUri(input.uri);
    const openDocument = findOpenDocument(uri);
    await assertEditableUri(uri, openDocument !== undefined);

    let document: vscode.TextDocument;
    try {
      document = openDocument ?? (await vscode.workspace.openTextDocument(uri));
    } catch (error) {
      throw new BridgeError("document-not-readable", "The document could not be opened.", undefined, {
        cause: error
      });
    }

    if (document.version !== input.expectedVersion) {
      throw new BridgeError("document-version-conflict", "The document version has changed.", {
        currentVersion: document.version,
        expectedVersion: input.expectedVersion
      });
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of input.edits) {
      workspaceEdit.replace(uri, toValidatedRange(document, edit.range), edit.newText);
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      throw new BridgeError("internal-error", "VS Code rejected the workspace edit.");
    }
    return {
      uri: document.uri.toString(),
      previousVersion: input.expectedVersion,
      currentVersion: document.version,
      editCount: input.edits.length,
      replacementBytes,
      saved: false
    };
  }
}

function validateEditCount(edits: readonly SerializedTextEdit[]): void {
  if (edits.length > MAX_EDITS_PER_APPLY) {
    throw new BridgeError("edit-limit-exceeded", "The edit count exceeds the limit.", {
      editCount: edits.length,
      maximumEdits: MAX_EDITS_PER_APPLY
    });
  }
}

function validateReplacementBytes(edits: readonly SerializedTextEdit[]): number {
  let byteLength = 0;
  for (const edit of edits) {
    byteLength += Buffer.byteLength(edit.newText, "utf8");
    if (byteLength > MAX_REPLACEMENT_BYTES) {
      throw new BridgeError("edit-limit-exceeded", "Replacement text exceeds the 4 MiB limit.", {
        replacementBytes: byteLength,
        maximumReplacementBytes: MAX_REPLACEMENT_BYTES
      });
    }
  }
  return byteLength;
}

function parseUri(value: string): vscode.Uri {
  try {
    const uri = vscode.Uri.parse(value, true);
    if (uri.scheme.length === 0) {
      throw new Error("URI scheme is required.");
    }
    return uri;
  } catch (error) {
    throw new BridgeError("invalid-tool-input", "A valid absolute URI is required.", undefined, {
      cause: error
    });
  }
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const requested = uri.toString();
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === requested);
}

async function assertEditableUri(uri: vscode.Uri, isOpen: boolean): Promise<void> {
  if (!isSupportedEnvironment(vscode.env.uiKind, vscode.env.remoteName)) {
    throw new BridgeError("workspace-boundary-violation", "Editing is unavailable in this environment.", {
      reason: "unsupported-environment"
    });
  }
  if (uri.scheme === "untitled") {
    if (!isOpen) {
      throw new BridgeError(
        "document-not-found",
        "An untitled document must already be open to be edited."
      );
    }
    return;
  }
  if (uri.scheme !== "file") {
    throw new BridgeError(
      "workspace-boundary-violation",
      "Custom-scheme documents cannot be edited in v1."
    );
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
    throw new BridgeError(
      "workspace-boundary-violation",
      "The requested URI is outside the current workspace."
    );
  }
  await assertRealPathInsideWorkspace({
    candidatePath: uri.fsPath,
    workspacePaths: folders
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath)
  });
}

function toValidatedRange(document: vscode.TextDocument, range: SerializedRange): vscode.Range {
  const start = toValidatedPosition(document, range.start);
  const end = toValidatedPosition(document, range.end);
  if (start.isAfter(end)) {
    throw new BridgeError("invalid-tool-input", "Edit range start must not follow its end.");
  }
  return new vscode.Range(start, end);
}

function toValidatedPosition(
  document: vscode.TextDocument,
  position: SerializedPosition
): vscode.Position {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0 ||
    position.line >= document.lineCount
  ) {
    throw new BridgeError("invalid-tool-input", "Edit position is outside the document.");
  }
  const line = document.lineAt(position.line);
  if (position.character > line.text.length) {
    throw new BridgeError("invalid-tool-input", "Edit character is outside the document line.");
  }
  return new vscode.Position(position.line, position.character);
}
