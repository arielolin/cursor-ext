import * as vscode from "vscode";
import {
  getGitRoot,
  getMonitoredRepositoriesByName,
  getRemoteUrl,
  getRepoName,
} from "./git-service";
import { Repository } from "../types/repository";

export interface WorkspaceInfo {
  repoData: Repository;
  baseBranch: string;
}

export class WorkspaceService {
  private workspaceInfo?: WorkspaceInfo;

  constructor() {
    this.workspaceInfo = undefined;
  }

  public async initialize(): Promise<boolean> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        return false;
      }

      const workspacePath = workspaceFolders[0].uri.fsPath;

      // Verify workspace root matches git root
      try {
        const gitRoot = await getGitRoot(workspacePath);
        if (gitRoot !== workspacePath) {
          vscode.window.showWarningMessage(
            "Apiiro: Not connected - workspace root must be the same as Git root directory.",
          );
          return false;
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Apiiro: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }

      const repoName = await getRepoName(workspacePath);
      const remoteUrl = await getRemoteUrl(workspacePath);

      if (!remoteUrl) {
        vscode.window.showErrorMessage(
          "Apiiro: Can't find remote URL for the current workspace",
        );
        return false;
      }

      const matchedMonitoredRepositories = await getMonitoredRepositoriesByName(
        repoName,
        remoteUrl,
      );

      if (matchedMonitoredRepositories.length === 0) {
        vscode.window.showErrorMessage(
          "Apiiro: No monitored repository found for the current workspace",
        );
        return false;
      }

      let baseBranch: string;
      let repoData: Repository;

      if (matchedMonitoredRepositories.length === 1) {
        baseBranch = matchedMonitoredRepositories[0].branchName;
        repoData = matchedMonitoredRepositories[0];
      } else {
        const branchData = await vscode.window.showQuickPick(
          matchedMonitoredRepositories.map((repo) => ({
            label: repo.branchName,
            detail: repo.name,
          })),
          {
            placeHolder: "Select Base Branch",
            matchOnDetail: true,
          },
        );

        if (!branchData) {
          vscode.window.showErrorMessage("Apiiro: No base branch selected");
          return false;
        }

        baseBranch = branchData.label;
        repoData = matchedMonitoredRepositories.find(
          (repo) => repo.branchName === baseBranch,
        ) as Repository;
      }

      if (!repoData) {
        vscode.window.showErrorMessage(
          `Apiiro: Failed to retrieve data for repository: ${repoName}`,
        );
        return false;
      }

      repoData.branchName = baseBranch;
      this.workspaceInfo = { repoData, baseBranch };

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Apiiro: ${errorMessage}`);
      return false;
    }
  }

  public getWorkspaceInfo(): WorkspaceInfo | undefined {
    return this.workspaceInfo;
  }
}
