import type * as vscode from "vscode";
import { BridgeController } from "./lifecycle/bridgeController";

let controller: BridgeController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new BridgeController(context);
  await controller.initialize();
}

export async function deactivate(): Promise<void> {
  const activeController = controller;
  controller = undefined;
  await activeController?.shutdown();
}

