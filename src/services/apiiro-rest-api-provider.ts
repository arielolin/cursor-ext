import axios, { AxiosInstance } from "axios";
import vscode from "vscode";
import { decodeJwt } from "../utils/string";

const API_BASE_URL = `${getEnvironmentData().AppUrl}`;

export function getEnvironmentData() {
  const token = getApiToken() as string;
  return decodeJwt(token);
}

export function getApiToken(): string | null {
  const config = vscode.workspace.getConfiguration("apiiroCode");
  const token = config.get("token");
  if (!token) {
    vscode.window.showErrorMessage(
      "Apiiro: no access token detected, please add token in the extension settings and reload.",
    );
    return null;
  }
  return token as string;
}

function createAxiosInstance(path: string) {
  const token = getApiToken();
  if (!token) {
    return null;
  }
  return axios.create({
    baseURL: API_BASE_URL + path,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
}

export const createApiiroRestApiClient = (path: string) =>
  createAxiosInstance(path) as AxiosInstance;
