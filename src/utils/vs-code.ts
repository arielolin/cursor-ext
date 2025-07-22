// src/utils/vs-code.ts

import * as vscode from "vscode";
import * as path from "path";

export function getRelativeFilePath(editor: vscode.TextEditor) {
  const currentFilePath = editor.document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(
    editor.document.uri,
  );

  return workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, currentFilePath)
    : null;
}

export async function openFileAtLine(
  filePath: string,
  lineNumber: number,
): Promise<vscode.TextEditor | undefined> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      throw new Error("No workspace folder found");
    }

    // Try to find the file in each workspace folder
    let fileUri: vscode.Uri | undefined;
    for (const folder of workspaceFolders) {
      const possiblePath = vscode.Uri.joinPath(folder.uri, filePath);
      try {
        await vscode.workspace.fs.stat(possiblePath);
        fileUri = possiblePath;
        break;
      } catch {
        continue;
      }
    }

    // If not found by direct path, try to find by filename
    if (!fileUri) {
      const fileName = path.basename(filePath);
      const files = await vscode.workspace.findFiles(`**/${fileName}`);
      if (files.length > 0) {
        // If multiple files found, try to find best match based on path segments
        fileUri = findBestMatchingFile(files, filePath);
      }
    }

    if (!fileUri) {
      throw new Error(`File not found in workspace: ${filePath}`);
    }

    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(lineNumber - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter,
    );

    return editor;
  } catch (error) {
    console.error("File open error:", error);
    vscode.window.showErrorMessage(
      `Failed to open file: ${filePath}. Try using 'Find in Files' to locate it.`,
    );
    return undefined;
  }
}

function findBestMatchingFile(
  files: vscode.Uri[],
  targetPath: string,
): vscode.Uri {
  // Split the target path into segments
  const targetSegments = targetPath.split("/").filter(Boolean);

  // Score each file based on matching path segments
  const scores = files.map((file) => {
    const fileSegments = file.fsPath.split(path.sep).filter(Boolean);
    let score = 0;
    let targetIdx = targetSegments.length - 1;
    let fileIdx = fileSegments.length - 1;

    // Compare segments from right to left
    while (targetIdx >= 0 && fileIdx >= 0) {
      if (
        targetSegments[targetIdx].toLowerCase() ===
        fileSegments[fileIdx].toLowerCase()
      ) {
        score += 1;
      }
      targetIdx--;
      fileIdx--;
    }
    return { uri: file, score };
  });

  // Return the file with the highest score
  return scores.reduce(
    (best, current) => (current.score > best.score ? current : best),
    { uri: files[0], score: -1 },
  ).uri;
}

export function getWorkspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
}

export function getCurrentWorkspaceFolder(
  uri: vscode.Uri,
): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

export function resolveWorkspacePath(
  relativePath: string,
): vscode.Uri | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, relativePath)
    : undefined;
}
