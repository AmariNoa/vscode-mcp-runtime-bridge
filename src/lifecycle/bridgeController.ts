import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { MfmAdapter } from "../adapters/mfm/adapter";
import { registerMfmTools } from "../adapters/mfm/tools";
import { BearerTokenStore } from "../core/auth";
import { BridgeError } from "../core/errors";
import type { BridgeLogger } from "../core/logging";
import { BridgeHttpServer } from "../server/bridgeHttpServer";
import { registerVsCodeTools } from "../vscode/registerTools";
import { VsCodeEditService } from "../vscode/editTools";
import { VsCodeToolsService } from "../vscode/workspaceTools";

const CONFIGURATION_SECTION = "vscodeMcp";
const OUTPUT_CHANNEL_NAME = "VS Code MCP Bridge";

export interface BridgeSessionInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly vscodeVersion: string;
  readonly remoteName: string | null;
  readonly endpoint: string;
}

export class BridgeController implements vscode.Disposable {
  private readonly sessionId = randomUUID();
  private readonly tokenStore: BearerTokenStore;
  private readonly output: vscode.OutputChannel;
  private readonly logger: BridgeLogger;
  private server: BridgeHttpServer | undefined;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.tokenStore = new BearerTokenStore(context.secrets);
    this.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.logger = {
      info: (event, metadata) => this.writeLog("info", event, metadata),
      error: (event, metadata) => this.writeLog("error", event, metadata)
    };
  }

  public async initialize(): Promise<void> {
    this.context.subscriptions.push(
      this,
      this.output,
      vscode.commands.registerCommand("vscodeMcp.copyEndpoint", () => this.copyEndpoint()),
      vscode.commands.registerCommand("vscodeMcp.copyClientConfiguration", () =>
        this.copyClientConfiguration()
      ),
      vscode.commands.registerCommand("vscodeMcp.regenerateAccessToken", () =>
        this.regenerateAccessToken()
      ),
      vscode.commands.registerCommand("vscodeMcp.restartServer", () => this.restart()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
          void this.restart();
        }
      })
    );
    await this.enqueueLifecycle(() => this.startIfEnabled());
  }

  public getSessionInfo(): BridgeSessionInfo | undefined {
    const endpoint = this.server?.endpoint;
    if (endpoint === undefined) {
      return undefined;
    }
    return {
      sessionId: this.sessionId,
      pid: process.pid,
      vscodeVersion: vscode.version,
      remoteName: vscode.env.remoteName ?? null,
      endpoint
    };
  }

  public restart(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.stop();
      await this.startIfEnabled();
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.enqueueLifecycle(() => this.stop());
  }

  public async shutdown(): Promise<void> {
    this.disposed = true;
    await this.enqueueLifecycle(() => this.stop());
  }

  private async startIfEnabled(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    if (!configuration.get<boolean>("enabled", true) || this.disposed) {
      return;
    }

    const host = configuration.get<string>("host", "127.0.0.1");
    const port = configuration.get<number>("port", 0);
    if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65_535) {
      await this.reportStartupFailure(
        new BridgeError("server-start-failed", "The configured host or port is invalid.")
      );
      return;
    }

    const mfmAdapter = new MfmAdapter();
    const vscodeTools = new VsCodeToolsService(async () => ({
      mfm: await mfmAdapter.getCapabilitySummary(false)
    }));
    const server = new BridgeHttpServer({
      host,
      port,
      getAccessToken: () => this.tokenStore.getOrCreate(),
      logger: this.logger,
      configureMcpServer: (mcpServer) => {
        registerVsCodeTools(
          mcpServer,
          vscodeTools,
          this.logger,
          this.sessionId,
          new VsCodeEditService(() =>
            vscode.workspace
              .getConfiguration(CONFIGURATION_SECTION)
              .get<boolean>("allowWorkspaceEdit", true)
          )
        );
        registerMfmTools(mcpServer, mfmAdapter, vscodeTools, this.logger);
      }
    });
    try {
      const endpoint = await server.start();
      this.server = server;
      this.logger.info("server-started", { endpoint });
    } catch (error) {
      await this.reportStartupFailure(error);
    }
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await server.stop();
      this.logger.info("server-stopped");
    }
  }

  private async copyEndpoint(): Promise<void> {
    const endpoint = this.server?.endpoint;
    if (endpoint === undefined) {
      await vscode.window.showWarningMessage("VS Code MCP Bridge is not running.");
      return;
    }
    await vscode.env.clipboard.writeText(endpoint);
  }

  private async copyClientConfiguration(): Promise<void> {
    const endpoint = this.server?.endpoint;
    if (endpoint === undefined) {
      await vscode.window.showWarningMessage("VS Code MCP Bridge is not running.");
      return;
    }
    const token = await this.tokenStore.getOrCreate();
    const configuration = {
      mcpServers: {
        vscode: {
          url: endpoint,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    };
    await vscode.env.clipboard.writeText(JSON.stringify(configuration, null, 2));
  }

  private async regenerateAccessToken(): Promise<void> {
    await this.tokenStore.regenerate();
    this.logger.info("access-token-regenerated");
    await vscode.window.showInformationMessage("VS Code MCP Bridge access token regenerated.");
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const pending = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = pending.catch((error: unknown) => {
      this.logger.error("lifecycle-failed", {
        errorCode: error instanceof BridgeError ? error.code : "internal-error"
      });
    });
    return pending;
  }

  private async reportStartupFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Unknown startup error.";
    this.logger.error("server-start-failed", { errorCode: "server-start-failed", message });
    await vscode.window.showErrorMessage(`VS Code MCP Bridge failed to start: ${message}`);
  }

  private writeLog(
    level: "info" | "error",
    event: string,
    metadata?: Readonly<Record<string, unknown>>
  ): void {
    const suffix = metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`;
    this.output.appendLine(`${new Date().toISOString()} ${level} ${event}${suffix}`);
  }
}
