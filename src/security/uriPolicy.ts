import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors";

export interface FileBoundaryInput {
  readonly candidatePath: string;
  readonly workspacePaths: readonly string[];
}

export async function assertRealPathInsideWorkspace({
  candidatePath,
  workspacePaths
}: FileBoundaryInput): Promise<void> {
  let candidateRealPath: string;
  try {
    candidateRealPath = await realpath(candidatePath);
  } catch (error) {
    throw new BridgeError("document-not-found", "The document does not exist.", undefined, {
      cause: error
    });
  }

  for (const workspacePath of workspacePaths) {
    let workspaceRealPath: string;
    try {
      workspaceRealPath = await realpath(workspacePath);
    } catch {
      continue;
    }
    if (isPathInside(workspaceRealPath, candidateRealPath)) {
      return;
    }
  }

  throw new BridgeError(
    "workspace-boundary-violation",
    "The requested URI is outside the current workspace."
  );
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const normalizedParent = resolve(parentPath);
  const normalizedCandidate = resolve(candidatePath);
  const pathFromParent = relative(normalizedParent, normalizedCandidate);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
}
