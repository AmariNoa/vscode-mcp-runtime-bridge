import * as vscode from "vscode";
import { BridgeError } from "../core/errors";
import { assertRealPathInsideWorkspace } from "../security/uriPolicy";

export const MAX_DOCUMENT_BYTES = 4 * 2 ** 20;
export const MAX_WORKSPACE_DIAGNOSTICS = 5_000;

export class VsCodeToolsService {
  public constructor(
    private readonly getExtensionCapabilities: () => Promise<Record<string, unknown>> = () =>
      Promise.resolve({})
  ) {}

  public getWorkspaceInfo(sessionId: string): Record<string, unknown> {
    const activeDocument = vscode.window.activeTextEditor?.document;
    return {
      sessionId,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        name: folder.name,
        index: folder.index,
        uri: folder.uri.toString()
      })),
      workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null,
      vscodeVersion: vscode.version,
      remoteName: vscode.env.remoteName ?? null,
      activeEditorUri: activeDocument?.uri.toString() ?? null,
      activeEditorLanguageId: activeDocument?.languageId ?? null,
      supportedEnvironment: isSupportedEnvironment(vscode.env.uiKind, vscode.env.remoteName)
    };
  }

  public async getCapabilities(): Promise<Record<string, unknown>> {
    return {
      supportedEnvironment: isSupportedEnvironment(vscode.env.uiKind, vscode.env.remoteName),
      extensions: await this.getExtensionCapabilities()
    };
  }

  public getOpenDocuments(): Record<string, unknown> {
    return {
      documents: vscode.workspace.textDocuments.map((document) => documentSummary(document))
    };
  }

  public async readDocument(uriText: string): Promise<Record<string, unknown>> {
    const uri = parseUri(uriText);
    const openDocument = findOpenDocument(uri);
    await assertReadableUri(uri, openDocument !== undefined);

    let document: vscode.TextDocument;
    try {
      document = openDocument ?? (await vscode.workspace.openTextDocument(uri));
    } catch (error) {
      throw new BridgeError("document-not-readable", "The document could not be opened.", undefined, {
        cause: error
      });
    }

    const text = document.getText();
    if (text.includes("\0")) {
      throw new BridgeError("document-not-readable", "Binary documents are not readable.");
    }
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > MAX_DOCUMENT_BYTES) {
      throw new BridgeError("document-too-large", "The document exceeds the 4 MiB limit.", {
        byteLength,
        maximumBytes: MAX_DOCUMENT_BYTES
      });
    }

    return {
      ...documentSummary(document),
      text,
      byteLength,
      eol: document.eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF"
    };
  }

  public getDiagnostics(): Record<string, unknown> {
    const diagnostics: Array<Record<string, unknown>> = [];
    let truncated = false;
    diagnosticsLoop:
    for (const [uri, uriDiagnostics] of vscode.languages.getDiagnostics()) {
      if (!isUriWithinLogicalWorkspace(uri)) {
        continue;
      }
      for (const diagnostic of uriDiagnostics) {
        if (diagnostics.length === MAX_WORKSPACE_DIAGNOSTICS) {
          truncated = true;
          break diagnosticsLoop;
        }
        diagnostics.push({
          uri: uri.toString(),
          severity: severityName(diagnostic.severity),
          code: diagnosticCode(diagnostic.code),
          source: diagnostic.source ?? null,
          message: diagnostic.message,
          range: serializeRange(diagnostic.range)
        });
      }
    }
    return {
      diagnostics,
      count: diagnostics.length,
      truncated
    };
  }
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

async function assertReadableUri(uri: vscode.Uri, isOpen: boolean): Promise<void> {
  if (!isSupportedEnvironment(vscode.env.uiKind, vscode.env.remoteName)) {
    throw new BridgeError("document-not-readable", "Document access is unavailable in this environment.", {
      reason: "unsupported-environment"
    });
  }
  if (uri.scheme === "untitled" || uri.scheme !== "file") {
    if (!isOpen) {
      throw new BridgeError(
        "workspace-boundary-violation",
        "Non-file documents must already be open in this VS Code window."
      );
    }
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
    throw new BridgeError(
      "workspace-boundary-violation",
      "The requested URI is outside the current workspace."
    );
  }
  await assertRealPathInsideWorkspace({
    candidatePath: uri.fsPath,
    workspacePaths: workspaceFolders
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath)
  });
}

function isUriWithinLogicalWorkspace(uri: vscode.Uri): boolean {
  if (uri.scheme === "file") {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
  }
  return findOpenDocument(uri) !== undefined;
}

function documentSummary(document: vscode.TextDocument): Record<string, unknown> {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    dirty: document.isDirty,
    version: document.version,
    isUntitled: document.isUntitled
  };
}

function serializeRange(range: vscode.Range): Record<string, unknown> {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function severityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | number | null {
  if (code === undefined) {
    return null;
  }
  return typeof code === "object" ? code.value : code;
}

export function isSupportedEnvironment(
  uiKind: vscode.UIKind,
  remoteName: string | undefined
): boolean {
  return uiKind === vscode.UIKind.Desktop && remoteName === undefined;
}
