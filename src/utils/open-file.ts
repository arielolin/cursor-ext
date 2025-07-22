import * as vscode from "vscode";
import path from "path";

export async function openRiskFile(
  filePath: string,
  lineNumber: number,
): Promise<void> {
  try {
    filePath = filePath.replace(/^\/+/, "");

    let fullPath = filePath;
    if (vscode.workspace.workspaceFolders?.length) {
      const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      if (filePath.startsWith("..")) {
        fullPath = path.resolve(workspaceRoot, filePath);
      } else {
        fullPath = path.join(workspaceRoot, filePath);
      }
    }

    let fileUri: vscode.Uri;
    try {
      fileUri = vscode.Uri.file(fullPath);
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      throw new Error(
        `File not found: ${fullPath} (original path: ${filePath})`,
      );
    }

    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document);

    const position = new vscode.Position(lineNumber - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter,
    );
  } catch (error) {
    if (lineNumber === 0) {
      vscode.window.showWarningMessage(`
      Line number ${lineNumber} is out of range.
      .`);
      return;
    }
    vscode.window.showErrorMessage(
      `Failed to open file ${filePath},${lineNumber}: ${error}`,
    );
  }
}
