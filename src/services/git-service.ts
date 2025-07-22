import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import NodeCache from "node-cache";
import { Repository } from "../types/repository";
import { URL } from "url";
import { createApiiroRestApiClient } from "./apiiro-rest-api-provider";

const REPO_API_BASE_URL = `/rest-api/v2`;

export async function getRepoName(workspacePath: string): Promise<string> {
  try {
    const remoteUrl = await runGitCommand(workspacePath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);

    const match = remoteUrl.match(/\/([^\/]+)\.git$/);
    if (match && match[1]) {
      return match[1];
    } else {
      throw new Error(
        "Apiiro: Unable to extract repository name from remote URL",
      );
    }
  } catch (error) {
    throw error;
  }
}

export async function getRemoteUrl(workspacePath: string): Promise<string> {
  try {
    return await runGitCommand(workspacePath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
  } catch (error) {
    throw error;
  }
}

export async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Git command failed: ${stderr}`));
      }
    });
  });
}

export async function getMonitoredRepositoriesByName(
  repoName: string,
  remoteUrl: string,
): Promise<Repository[]> {
  const apiiroRestApiClient = createApiiroRestApiClient(REPO_API_BASE_URL);
  if (!apiiroRestApiClient) {
    return [];
  }

  try {
    const params = {
      "filters[RepositoryName]": repoName,
    };

    const paramsSerializer = (params: Record<string, string>) => {
      return Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
    };

    const response = await apiiroRestApiClient.get("/repositories", {
      params,
      paramsSerializer,
    });

    if (
      !(response.data && response.data.items && response.data.items.length > 0)
    ) {
      return [];
    }

    const remoteUrlHostname = extractGitHostnameFromUrl(remoteUrl);

    const filteredRepos = response.data.items.filter((repo: Repository) => {
      const repoUrlHostname = extractGitHostnameFromUrl(repo.serverUrl);
      return repo.name === repoName && repoUrlHostname === remoteUrlHostname;
    });

    if (filteredRepos.length <= 0) {
      return [];
    }

    vscode.window.showInformationMessage(
      `Connected to repository "${repoName}" at ${remoteUrl}.`,
    );
    return filteredRepos;
  } catch (error: any) {
    console.error("API Error:", error.response?.data || error.message);
    vscode.window.showErrorMessage(
      `Error retrieving repository: ${error.message}`,
    );
    return [];
  }
}

function extractGitHostnameFromUrl(url: string): string {
  try {
    // Handle SSH URLs
    if (url.startsWith("git@")) {
      const parts = url.split("@")[1].split(":");
      return parts[0];
    }
    // Handle HTTPS URLs
    const parsedUrl = new URL(url);
    return parsedUrl.hostname;
  } catch (error) {
    console.error(`Error parsing URL: ${url}`, error);
    return "";
  }
}

export async function getGitRoot(workspacePath: string): Promise<string> {
  try {
    const gitRoot = await runGitCommand(workspacePath, [
      "rev-parse",
      "--show-toplevel",
    ]);
    return gitRoot.replace(/[\\/]/g, path.sep);
  } catch (error) {
    throw new Error(
      `Failed to determine Git root directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
