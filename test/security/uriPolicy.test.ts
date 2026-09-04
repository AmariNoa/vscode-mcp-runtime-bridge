import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRealPathInsideWorkspace, isPathInside } from "../../src/security/uriPolicy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("workspace URI policy", () => {
  it("distinguishes descendants from sibling-prefix paths", () => {
    expect(isPathInside(join("root", "workspace"), join("root", "workspace", "file.mfm"))).toBe(
      true
    );
    expect(isPathInside(join("root", "workspace"), join("root", "workspace-other", "file.mfm"))).toBe(
      false
    );
  });

  it("accepts an existing file under a real workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-mcp-uri-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const candidate = join(workspace, "nested", "file.mfm");
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(candidate, "test", "utf8");

    await expect(
      assertRealPathInsideWorkspace({ candidatePath: candidate, workspacePaths: [workspace] })
    ).resolves.toBeUndefined();
  });

  it("rejects existing files outside all workspace roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-mcp-uri-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside", "file.mfm");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(outside, "test", "utf8");

    await expect(
      assertRealPathInsideWorkspace({ candidatePath: outside, workspacePaths: [workspace] })
    ).rejects.toMatchObject({ code: "workspace-boundary-violation" });
  });

  it("maps a missing candidate to document-not-found", async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-mcp-uri-"));
    temporaryDirectories.push(root);

    await expect(
      assertRealPathInsideWorkspace({
        candidatePath: join(root, "missing.mfm"),
        workspacePaths: [root]
      })
    ).rejects.toMatchObject({ code: "document-not-found" });
  });
});
