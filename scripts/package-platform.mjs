import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";

const target = readRequiredOption("--target");
const hostTarget = getHostTarget();
if (hostTarget === undefined) {
  throw new Error(`No reviewed Chromium distribution is available for ${process.platform}-${process.arch}.`);
}
if (target !== hostTarget) {
  throw new Error(`Target ${target} must be packaged on a matching ${hostTarget} host.`);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const browserDirectory = resolve(repositoryRoot, ".playwright-browsers");
const packageReadmePath = resolve(browserDirectory, "PACKAGE_README.md");
const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const outputPath = resolve(
  repositoryRoot,
  `${packageManifest.name}-${target}-${packageManifest.version}.vsix`
);
if (dirname(browserDirectory) !== repositoryRoot || basename(browserDirectory) !== ".playwright-browsers") {
  throw new Error("Refusing to prepare an unexpected browser directory.");
}

const environment = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browserDirectory
};
const packageReadme =
  "# VS Code MCP Bridge\n\nLocal MCP access to approved VS Code and extension APIs.\n";
let relativeExecutablePath = await findReusableBrowser(browserDirectory, target);
if (relativeExecutablePath === undefined) {
  await rm(browserDirectory, { recursive: true, force: true });
  await mkdir(browserDirectory, { recursive: true });
  run(
    process.execPath,
    [resolve(repositoryRoot, "node_modules/playwright/cli.js"), "install", "chromium"],
    environment
  );

  process.env.PLAYWRIGHT_BROWSERS_PATH = browserDirectory;
  const { chromium } = await import("playwright");
  const executablePath = resolve(chromium.executablePath());
  if (!existsSync(executablePath)) {
    throw new Error("Playwright completed without producing the expected Chromium executable.");
  }
  relativeExecutablePath = relative(browserDirectory, executablePath);
  if (
    relativeExecutablePath === "" ||
    relativeExecutablePath === ".." ||
    relativeExecutablePath.startsWith(`..${sep}`)
  ) {
    throw new Error("The installed Chromium executable is outside the extension-owned directory.");
  }

  await writeFile(
    resolve(browserDirectory, "browser-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        target,
        playwrightVersion: "1.62.1",
        executablePath: relativeExecutablePath.replaceAll("\\", "/")
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
await writeFile(
  packageReadmePath,
  packageReadme,
  "utf8"
);

run(process.execPath, [resolve(repositoryRoot, "esbuild.mjs"), "--production"], environment);
run(
  process.execPath,
  [
    resolve(repositoryRoot, "node_modules/@vscode/vsce/vsce"),
    "package",
    "--target",
    target,
    "--out",
    outputPath,
    "--readme-path",
    ".playwright-browsers/PACKAGE_README.md",
    "--allow-missing-repository",
    "--skip-license"
  ],
  environment
);
await verifyPackage(outputPath, relativeExecutablePath, packageReadme);

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Usage: npm run package -- ${name} <platform-target>`);
  }
  return value;
}

function getHostTarget() {
  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }
  if (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64")) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    return `linux-${process.arch}`;
  }
  return undefined;
}

async function findReusableBrowser(directory, expectedTarget) {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(directory, "browser-manifest.json"), "utf8")
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.target !== expectedTarget ||
      manifest.playwrightVersion !== "1.62.1" ||
      typeof manifest.executablePath !== "string"
    ) {
      return undefined;
    }
    const executablePath = resolve(directory, manifest.executablePath);
    const relativePath = relative(directory, executablePath);
    return relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      existsSync(executablePath)
      ? relativePath
      : undefined;
  } catch {
    return undefined;
  }
}

async function verifyPackage(vsixPath, browserExecutablePath, expectedReadme) {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(await readFile(vsixPath));
  const names = Object.keys(archive.files);
  const forbiddenRoots = [
    "extension/AGENTS.md",
    "extension/CLAUDE.md",
    "extension/.gitignore",
    "extension/docs/",
    "extension/contracts/sources/",
    "extension/.github/",
    "extension/src/",
    "extension/test/"
  ];
  const leaked = names.find((name) =>
    forbiddenRoots.some((forbidden) =>
      forbidden.endsWith("/") ? name.startsWith(forbidden) : name === forbidden
    )
  );
  if (leaked !== undefined) {
    throw new Error(`Forbidden local-only content was included in the VSIX: ${leaked}`);
  }

  const readme = archive.file("extension/readme.md");
  const manifest = archive.file("extension/.playwright-browsers/browser-manifest.json");
  const browser = archive.file(
    `extension/.playwright-browsers/${browserExecutablePath.replaceAll("\\", "/")}`
  );
  const extension = archive.file("extension/dist/extension.js");
  if (readme === null || (await readme.async("string")) !== expectedReadme) {
    throw new Error("The VSIX did not contain the generated disclosure-safe README.");
  }
  if (manifest === null || browser === null || extension === null) {
    throw new Error("The VSIX is missing its runtime bundle or packaged Chromium files.");
  }
}

function run(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}
