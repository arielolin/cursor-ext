import * as vscode from "vscode";
import { RiskHighlighter } from "./modules/highlight-risks/risks-highlighter";
import { remediateRisk } from "./modules/remediate-risks/remediate-risks";
import { Repository } from "./types/repository";
import _ from "lodash";
import { AuthService } from "./services/auth-service";
import { WorkspaceService } from "./services/workspace-service";
import { openFileAtLine } from "./utils/vs-code";
import { InventoryTreeProvider } from "./modules/apiiro-pane/inventory/inventory-tree";
import { RisksTreeProvider } from "./modules/apiiro-pane/risks-pane/risks-tree";
import { openRiskFile } from "./utils/open-file";

import { Risk } from "./types/risk";
import { CursorService } from "./services/cursor-service";

let filePanel: vscode.WebviewPanel | undefined;
let repoData: Repository;
let preventHighlights = false;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize extension logger
  const logger = vscode.window.createOutputChannel('Apiiro Extension');
  logger.appendLine(`[${new Date().toISOString()}] [INFO] Apiiro extension activating...`);

  const authService = AuthService.getInstance();
  const workspaceService = new WorkspaceService();

  const isAuthenticated = await authService.verifyAuthentication();
  if (!isAuthenticated) {
    logger.appendLine(`[${new Date().toISOString()}] [WARN] Authentication failed`);
    return;
  }

  const isInitialized = await workspaceService.initialize();
  if (!isInitialized) {
    logger.appendLine(`[${new Date().toISOString()}] [WARN] Workspace initialization failed`);
    return;
  }
  const workspaceInfo = workspaceService.getWorkspaceInfo();
  if (!workspaceInfo) {
    logger.appendLine(`[${new Date().toISOString()}] [WARN] No workspace info available`);
    return;
  }

  repoData = workspaceInfo.repoData;

  const inventoryProvider = new InventoryTreeProvider(repoData);

  const inventoryView = vscode.window.createTreeView("inventoryExplorer", {
    treeDataProvider: inventoryProvider,
  });

  const refreshInventoryCommand = vscode.commands.registerCommand(
    "inventory.refresh",
    () => {
      inventoryProvider.refresh();
    },
  );

  const openFileCommand = vscode.commands.registerCommand(
    "inventory.openFile",
    async (filePath: string, lineNumber: number) => {
      await openFileAtLine(filePath, lineNumber);
    },
  );

  const risksProvider = new RisksTreeProvider(repoData);
  vscode.window.registerTreeDataProvider("risksExplorer", risksProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "risks.openFile",
      async (filePath: string, lineNumber: number) => {
        await openRiskFile(filePath, lineNumber);
      },
    ),
  );

  const riskHighlighter = new RiskHighlighter(context);

  const highlightRisks = async (
    editor: vscode.TextEditor,
    repo: Repository,
  ) => {
    if (!preventHighlights) {
      await riskHighlighter.highlightRisksForActiveFile(editor, repo);
    }
  };

  const highlightDisposable = vscode.commands.registerCommand(
    "apiiro-code.highlightRisks",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await highlightRisks(editor, repoData);
      } else {
        vscode.window.showWarningMessage("No active editor");
      }
    },
  );

  const remediateDisposable = vscode.commands.registerCommand(
    "apiiro-code.remediate",
    async (risk) => {
      if (preventHighlights) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        preventHighlights = true;
        await riskHighlighter.removeAllHighlights(editor);
        await remediateRisk(
          editor,
          risk,
          repoData,
          () => (preventHighlights = false),
        );
      }
    },
  );

  const cursorService = CursorService.getInstance();

  const openCursorChatDisposable = vscode.commands.registerCommand(
    "apiiro-code.openCursorChat",
    async (risk: Risk) => {
      await cursorService.openCursorChatWithRisk(risk);
    },
  );

  // Register logger commands
  const showLogsCommand = vscode.commands.registerCommand('apiiro.showLogs', () => {
    logger.show();
  });

  const clearLogsCommand = vscode.commands.registerCommand('apiiro.clearLogs', () => {
    logger.clear();
    logger.appendLine(`[${new Date().toISOString()}] [INFO] Logs cleared by user`);
  });

  context.subscriptions.push(
    highlightDisposable,
    remediateDisposable,
    openCursorChatDisposable,
    refreshInventoryCommand,
    openFileCommand,
    inventoryView,
    showLogsCommand,
    clearLogsCommand
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor) {
        await highlightRisks(editor, repoData);
      }
    }),
  );

  // Trigger local secrets detection on file save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === document) {
        logger.appendLine(`[${new Date().toISOString()}] [INFO] File saved, re-scanning for secrets: ${document.fileName}`);
        await highlightRisks(editor, repoData);
      }
    }),
  );

  // Lightweight debounced highlighting for text changes (Apiiro risks only)
  const debounceApiiroHighlight = _.debounce(async (editor: vscode.TextEditor) => {
    await riskHighlighter.highlightApiiroRisksOnly(editor, repoData);
  }, 500);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === event.document) {
        // Only remove highlights and re-highlight Apiiro risks (not local secrets)
        await riskHighlighter.removeAllHighlights(editor);
        debounceApiiroHighlight(editor);
      }
    }),
  );

  if (vscode.window.activeTextEditor) {
    await highlightRisks(vscode.window.activeTextEditor, repoData);
  }

  inventoryProvider.refresh();

  logger.appendLine(`[${new Date().toISOString()}] [INFO] Apiiro extension activated successfully`);
}

export function deactivate() {
  if (filePanel) {
    filePanel.dispose();
  }

  const logger = vscode.window.createOutputChannel('Apiiro Extension');
  logger.appendLine(`[${new Date().toISOString()}] [INFO] Apiiro extension deactivating...`);
  logger.dispose();
}
