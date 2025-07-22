import { Risk, RISK_CATEGORIES, riskLevels } from "../types/risk";
import { createApiiroRestApiClient } from "./apiiro-rest-api-provider";
import * as vscode from "vscode";
import NodeCache from "node-cache";
import axios from "axios";
import * as path from "path";

const RISK_API_BASE_URL = `/rest-api/v1` as const;
const MIN_CONCURRENT_REQUESTS = 3 as const;
const MAX_CONCURRENT_REQUESTS = 5 as const;
const PAGE_SIZE = 100 as const;

const cache = new NodeCache({ stdTTL: 600 });

type AxiosInstance = axios.AxiosInstance;

export class RiskService {
  private static instance: RiskService;
  private apiClient: ReturnType<typeof createApiiroRestApiClient>;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.apiClient = createApiiroRestApiClient(RISK_API_BASE_URL);
    this.outputChannel = vscode.window.createOutputChannel("Risk Service");
  }

  static getInstance(): RiskService {
    if (!RiskService.instance) {
      RiskService.instance = new RiskService();
    }
    return RiskService.instance;
  }

  private log(message: string) {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private async fetchRisksCategoryPage(
    axiosInstance: AxiosInstance,
    params: Record<string, any>,
    paramsSerializer: (params: Record<string, string[]>) => string,
    skip: number,
  ): Promise<{ risks: Risk[]; totalItemCount: number }> {
    this.log(`Fetching risks page with skip=${skip}`);
    const requestParams = {
      ...params,
      skip: [skip.toString()],
      pageSize: [PAGE_SIZE.toString()],
    };

    const response = await axiosInstance.get("/risks", {
      params: requestParams,
      paramsSerializer,
    });

    this.log(`Received ${response.data.items?.length || 0} risks for page`);
    return {
      risks:
        response.data.items.filter(
          (risk: Risk) => risk.sourceCode.lineNumber !== 0,
        ) || [],
      totalItemCount: response.data.paging.totalItemCount,
    };
  }

  private async fetchRisksByCategory(
    axiosInstance: AxiosInstance,
    category: keyof typeof RISK_CATEGORIES,
    baseParams: Record<string, string[]>,
    paramsSerializer: (params: Record<string, string[]>) => string,
  ): Promise<Risk[]> {
    this.log(`Starting to fetch risks for category: ${category}`);

    const params = {
      ...baseParams,
      "filters[RiskCategory]": [category],
      "filters[RiskLevel]": [
        riskLevels.Critical,
        riskLevels.High,
        riskLevels.Medium,
        riskLevels.Low,
      ],
    };

    this.log(`Request params: ${JSON.stringify(params)}`);

    const initialPage = await this.fetchRisksCategoryPage(
      axiosInstance,
      params,
      paramsSerializer,
      0,
    );

    let allRisks = initialPage.risks;
    const totalItemCount = initialPage.totalItemCount;
    this.log(
      `Total items for category ${RISK_CATEGORIES[category]}: ${totalItemCount}`,
    );

    if (allRisks.length > 0) {
      this.log(
        `Sample risk from ${RISK_CATEGORIES[category]}: ${JSON.stringify(allRisks[0])}`,
      );
    }

    if (totalItemCount <= PAGE_SIZE) {
      return allRisks;
    }

    const remainingPages = Math.ceil(totalItemCount / PAGE_SIZE);
    const concurrentRequests = Math.min(
      MAX_CONCURRENT_REQUESTS,
      Math.max(MIN_CONCURRENT_REQUESTS, Math.floor(remainingPages / 2)),
    );

    this.log(
      `Fetching remaining ${remainingPages - 1} pages with ${concurrentRequests} concurrent requests`,
    );

    for (let i = 1; i < remainingPages; i += concurrentRequests) {
      const pagePromises = [];
      for (let j = 0; j < concurrentRequests && i + j < remainingPages; j++) {
        const skip = (i + j) * PAGE_SIZE;
        pagePromises.push(
          this.fetchRisksCategoryPage(
            axiosInstance,
            params,
            paramsSerializer,
            skip,
          ),
        );
      }

      const pages = await Promise.all(pagePromises);
      const newRisks = pages.flatMap((page) => page.risks);
      allRisks = allRisks.concat(newRisks);
    }

    this.log(
      `Completed fetching all risks for category ${RISK_CATEGORIES[category]}. Total: ${allRisks.length}`,
    );

    return allRisks;
  }

  async getRisksForRepo(
    repoId: string,
  ): Promise<{ risks: Risk[]; totalCount: number }> {
    this.log(`Getting risks for repo: ${repoId}`);
    const cacheKey = `repo_risks_${repoId}`;
    const cachedRisks = cache.get<{ risks: Risk[]; totalCount: number }>(
      cacheKey,
    );

    if (cachedRisks) {
      this.log(`Returning cached risks for repo ${repoId}`);
      return cachedRisks;
    }

    try {
      const baseParams = {
        "filters[RepositoryID]": [repoId],
      };

      const paramsSerializer = (params: Record<string, string[]>) => {
        return Object.entries(params)
          .flatMap(([key, values]) =>
            values.map((value) => `${key}=${encodeURIComponent(value)}`),
          )
          .join("&");
      };

      this.log("Starting parallel fetch for all risk categories");
      const categoryPromises = Object.keys(RISK_CATEGORIES).map(
        async (category) => {
          try {
            return await this.fetchRisksByCategory(
              this.apiClient!,
              category as keyof typeof RISK_CATEGORIES,
              baseParams,
              paramsSerializer,
            );
          } catch (error: any) {
            this.log(`Error fetching category ${category}: ${error.message}`);
            return [];
          }
        },
      );

      const categoryResults = await Promise.all(categoryPromises);
      const allRisks = categoryResults.flat();

      this.log(`Total risks fetched: ${allRisks.length}`);

      // Log summary of risks by category
      Object.keys(RISK_CATEGORIES).forEach((category) => {
        const categoryRisks = allRisks.filter(
          (risk) =>
            risk.riskCategory ===
            RISK_CATEGORIES[category as keyof typeof RISK_CATEGORIES],
        );
        this.log(`Category ${category} has ${categoryRisks.length} risks`);
      });

      const normalizedRisks = allRisks.map((risk) => ({
        ...risk,
        sourceCode: risk.sourceCode
          ? {
              ...risk.sourceCode,
              filePath: this.normalizeFilePath(risk.sourceCode.filePath),
            }
          : risk.sourceCode,
      }));

      const result = {
        risks: normalizedRisks,
        totalCount: normalizedRisks.length,
      };

      cache.set(cacheKey, result);
      this.log(`Cached results for repo ${repoId}`);
      return result;
    } catch (error: any) {
      this.log(`Error retrieving risks: ${error.message}`);
      throw error; // Let the tree provider handle the error
    }
  }

  private normalizeFilePath(filePath: string): string {
    if (!filePath) return filePath;

    const normalizedPath = filePath.replace(/\\/g, "/");

    if (
      path.isAbsolute(normalizedPath) &&
      vscode.workspace.workspaceFolders?.length
    ) {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const relativePath = path.relative(workspacePath, normalizedPath);
      return relativePath.replace(/\\/g, "/");
    }

    return normalizedPath.replace(/^\/+/, "");
  }
}

export const riskService = RiskService.getInstance();
