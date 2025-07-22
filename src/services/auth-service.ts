import * as vscode from "vscode";
import axios from "axios";
import {
  getEnvironmentData,
  getApiToken,
  createApiiroRestApiClient,
} from "./apiiro-rest-api-provider";

const REPO_API_BASE_URL = `/rest-api/v2`;

export class AuthService {
  private static instance: AuthService;

  private constructor() {}

  static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  async verifyAuthentication(): Promise<boolean> {
    try {
      const token = getApiToken();
      if (!token) {
        vscode.window.showErrorMessage(
          "Apiiro: No token found, please add your access token in the extension settings",
        );
        return false;
      }

      const envData = getEnvironmentData();
      if (!envData || !envData.exp || !envData.key) {
        vscode.window.showErrorMessage("Apiiro: Invalid token format");
        return false;
      }

      if (Date.now() >= envData.exp * 1000) {
        vscode.window.showErrorMessage("Apiiro: Token has expired");
        return false;
      }

      await verifyConnection();
      return true;
    } catch (error) {
      let errorMessage = "Authentication failed";
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          errorMessage = "Invalid or expired token";
        } else if (!error.response) {
          errorMessage = "Failed to connect to Apiiro service";
        }
      }
      vscode.window.showErrorMessage(`Apiiro: ${errorMessage}`);
      return false;
    }
  }
}

async function verifyConnection(): Promise<boolean> {
  const apiiroRestApiClient = createApiiroRestApiClient(REPO_API_BASE_URL);
  if (!apiiroRestApiClient) {
    vscode.window.showErrorMessage(
      "Apiiro: Failed to create Apiiro API client",
    );
    return false;
  }

  try {
    const params = {
      pageSize: "1",
      page: "1",
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

    return !!(response.data && response.data.items);
  } catch (error: any) {
    vscode.window.showErrorMessage(
      "Could not verify connection to Apiiro. Please check your token and try again. ",
    );
    throw new Error();
  }
}
