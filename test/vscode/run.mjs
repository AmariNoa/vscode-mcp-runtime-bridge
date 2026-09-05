import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testOutputDirectory = resolve(repositoryRoot, ".test-dist/vscode");
const extensionTestsPath = resolve(testOutputDirectory, "index.js");

try {
  await esbuild.build({
    entryPoints: [resolve(repositoryRoot, "test/vscode/suite/index.ts")],
    outfile: extensionTestsPath,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
    logLevel: "info"
  });

  await runTests({
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath,
    launchArgs: [repositoryRoot, "--disable-workspace-trust", "--skip-welcome"]
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(resolve(repositoryRoot, ".test-dist"), { recursive: true, force: true });
}
