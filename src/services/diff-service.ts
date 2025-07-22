import { Repository } from "../types/repository";
import vscode from "vscode";
import path from "path";
import * as diff from "diff";
import NodeCache from "node-cache";
import { runGitCommand } from "./git-service";

interface LineChangeInfo {
  originalLineNumber: number;
  hasChanged: boolean;
  hasMoved: boolean;
  newLineNum: number | null;
  errors: string[];
}

const cache = new NodeCache({ stdTTL: 600 }); // 5 minutes cache

export async function detectLineChanges(
  lineNumbers: number[],
  repoData: Repository,
): Promise<LineChangeInfo[]> {
  let errors: string[] = [];

  const baseBranch = repoData.branchName;
  if (!baseBranch) {
    errors.push("Repository data is missing or incomplete");
    return [
      {
        errors,
        originalLineNumber: 0,
        hasChanged: false,
        hasMoved: false,
        newLineNum: 0,
      },
    ];
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    errors.push("No active text editor");
    return [
      {
        errors,
        originalLineNumber: 0,
        hasChanged: false,
        hasMoved: false,
        newLineNum: 0,
      },
    ];
  }

  const document = editor.document;
  const absoluteFilePath = document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    errors.push("File is not part of a workspace");
    return [
      {
        errors,
        originalLineNumber: 0,
        hasChanged: false,
        hasMoved: false,
        newLineNum: 0,
      },
    ];
  }

  try {
    const workspacePath = workspaceFolder.uri.fsPath;
    const relativeFilePath = path.relative(workspacePath, absoluteFilePath);

    // Fetch the latest changes
    const fetchOrigin = cache.get("fetchOrigin");

    if (!fetchOrigin) {
      await runGitCommand(workspacePath, ["fetch", "origin"]);
      cache.set("fetchOrigin", true);
    }

    // Get the content of the file in the base branch
    let baseBranchContent: string;
    try {
      baseBranchContent = await runGitCommand(workspacePath, [
        "show",
        `origin/${baseBranch}:${relativeFilePath}`,
      ]);
    } catch (error) {
      errors.push(
        `Error fetching base branch content: ${error instanceof Error ? error.message : String(error)}`,
      );
      baseBranchContent = "";
    }

    // Get the content of the current file from the active editor
    const currentContent = document.getText();

    if (errors.length > 0) {
      return [
        {
          errors,
          originalLineNumber: 0,
          hasChanged: false,
          hasMoved: false,
          newLineNum: 0,
        },
      ];
    }

    // Calculate the diff
    const diffResult = diff.structuredPatch(
      "base",
      "current",
      baseBranchContent,
      currentContent,
      "",
      "",
    );

    let results: LineChangeInfo[] = lineNumbers.map((lineNumber) => ({
      originalLineNumber: lineNumber,
      hasChanged: baseBranchContent === "", // If base content is empty, all lines are new
      hasMoved: false,
      newLineNum: lineNumber,
      errors: [],
    }));

    if (baseBranchContent !== "") {
      let lineMapping = new Map<number, number>();
      let currentOldLine = 1;
      let currentNewLine = 1;

      for (const hunk of diffResult.hunks) {
        // Map unchanged lines before the hunk
        while (currentOldLine < hunk.oldStart) {
          lineMapping.set(currentOldLine, currentNewLine);
          currentOldLine++;
          currentNewLine++;
        }

        for (const line of hunk.lines) {
          if (line.startsWith("-")) {
            // Removed line
            currentOldLine++;
          } else if (line.startsWith("+")) {
            // Added line
            currentNewLine++;
          } else {
            // Unchanged line
            lineMapping.set(currentOldLine, currentNewLine);
            currentOldLine++;
            currentNewLine++;
          }
        }
      }

      // Map any remaining unchanged lines
      while (currentOldLine <= baseBranchContent.split("\n").length) {
        lineMapping.set(currentOldLine, currentNewLine);
        currentOldLine++;
        currentNewLine++;
      }

      // Update results based on the mapping
      results.forEach((result) => {
        const newLineNum = lineMapping.get(result.originalLineNumber);
        if (newLineNum === undefined) {
          result.hasChanged = true;
          result.hasMoved = false;
          result.newLineNum = null;
        } else {
          result.newLineNum = newLineNum;
          result.hasMoved = newLineNum !== result.originalLineNumber;
        }
      });
    }

    return results;
  } catch (error) {
    errors.push(`${error}`);
    return [
      {
        errors,
        originalLineNumber: 0,
        hasChanged: false,
        hasMoved: false,
        newLineNum: 0,
      },
    ];
  }
}
