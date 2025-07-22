import axios from "axios";
import vscode from "vscode";
import { Risk, riskLevels } from "../types/risk";
import NodeCache from "node-cache";
import { Repository } from "../types/repository";
import { createApiiroRestApiClient } from "./apiiro-rest-api-provider";

const RISK_API_BASE_URL = `/rest-api/v1` as const;
const MIN_CONCURRENT_REQUESTS = 3 as const;
const MAX_CONCURRENT_REQUESTS = 5 as const;
const PAGE_SIZE = 100 as const; // Increase page size to reduce number of requests

const cache = new NodeCache({ stdTTL: 600 }); //5 minutes cache
const logger = vscode.window.createOutputChannel("file-Risks-service");
type AxiosInstance = axios.AxiosInstance;

async function fetchRisksPage(
  axiosInstance: AxiosInstance,
  riskCategory: string,
  params: Record<string, string[]>,
  paramsSerializer: (params: Record<string, string[]>) => string,
  skip: number,
): Promise<{ risks: Risk[]; totalItemCount: number }> {
  const baseURL = axiosInstance.defaults.baseURL || "";
  const endpoint =
    riskCategory === "Api" ? `/risks` : `/risks/${riskCategory.toLowerCase()}`;

  const requestParams = {
    ...params,
    ...(riskCategory !== "Api" && {
      "filters[RiskCategory]": [riskCategory],
    }),

    "filters[RiskLevel][0]": [riskLevels.Critical],
    "filters[RiskLevel][1]": [riskLevels.High],
    "filters[RiskLevel][2]": [riskLevels.Medium],
    "filters[RiskLevel][3]": [riskLevels.Low],
    skip: [skip.toString()],
  };

  axiosInstance.interceptors.request.use((config) => {
    logger.appendLine("fetching risks from: ");
    logger.appendLine(
      (config.baseURL ?? "") +
        (config.url ?? "") +
        "?" +
        new URLSearchParams(config.params).toString(),
    );

    return config;
  });

  const response = await axiosInstance.get(endpoint, {
    params: requestParams,
    paramsSerializer,
  });

  let risks = response.data.items || [];
  let totalItemCount = response.data.paging.totalItemCount;
  logger.appendLine(
    `Received ${risks.length} ${riskCategory} risks for page ${skip}`,
  );

  if (riskCategory === "Api") {
    risks = risks.filter(
      (risk: Risk) =>
        risk.riskCategory === "Entry Point Changes" ||
        risk.riskCategory === "Sensitive Data",
    );
    totalItemCount = risks.length;
  }

  return {
    risks,
    totalItemCount,
  };
}

async function fetchCategoryRisks(
  axiosInstance: AxiosInstance,
  riskCategory: string,
  params: Record<string, string[]>,
  paramsSerializer: (params: Record<string, string[]>) => string,
): Promise<Risk[]> {
  const initialPage = await fetchRisksPage(
    axiosInstance,
    riskCategory,
    params,
    paramsSerializer,
    0,
  );
  let allRisks = initialPage.risks;
  const totalItemCount = initialPage.totalItemCount;

  if (totalItemCount <= PAGE_SIZE) {
    return allRisks;
  }

  const remainingPages = Math.ceil((totalItemCount - PAGE_SIZE) / PAGE_SIZE);
  const concurrentRequests = Math.min(
    MAX_CONCURRENT_REQUESTS,
    Math.max(MIN_CONCURRENT_REQUESTS, Math.floor(remainingPages / 2)),
  );

  for (let i = 1; i < remainingPages; i += concurrentRequests) {
    const pagePromises = [];
    for (let j = 0; j < concurrentRequests && i + j < remainingPages; j++) {
      const skip = (i + j) * PAGE_SIZE;
      pagePromises.push(
        fetchRisksPage(
          axiosInstance,
          riskCategory,
          params,
          paramsSerializer,
          skip,
        ),
      );
    }
    const pages = await Promise.all(pagePromises);
    allRisks = allRisks.concat(pages.flatMap((page) => page.risks));
  }

  return allRisks;
}

export async function findRisksForFile(
  relativeFilePath: string,
  repoData: Repository,
): Promise<Risk[]> {
  const cacheKey = `risks_${relativeFilePath}`;
  const cachedRisks = cache.get<Risk[]>(cacheKey);
  if (cachedRisks) {
    return cachedRisks;
  }

  const apiiroClient = createApiiroRestApiClient(RISK_API_BASE_URL);

  try {
    const params = {
      "filters[CodeReference]": [relativeFilePath],
      "filters[RepositoryID]": [repoData.key],
      pageSize: ["100"],
    };

    const paramsSerializer = (params: Record<string, string[]>) => {
      return Object.entries(params)
        .flatMap(([key, values]) =>
          values.map((value) => `${key}=${encodeURIComponent(value)}`),
        )
        .join("&");
    };

    const [ossRisks, secretsRisks, sastRisks, apiRisks] = await Promise.all([
      fetchCategoryRisks(apiiroClient!, "OSS", params, paramsSerializer),
      fetchCategoryRisks(apiiroClient!, "Secrets", params, paramsSerializer),
      fetchCategoryRisks(apiiroClient!, "SAST", params, paramsSerializer),
      fetchCategoryRisks(apiiroClient!, "Api", params, paramsSerializer),
    ]);

    const allRisks = [...ossRisks, ...secretsRisks, ...sastRisks, ...apiRisks];

    logger.appendLine(`Found ${allRisks.length} risks for ${relativeFilePath}`);

    cache.set(cacheKey, allRisks);
    return allRisks;
  } catch (error: any) {
    console.error("API Error:", error.response?.data || error.message);
    vscode.window.showErrorMessage(`Error retrieving risks: ${error.message}`);
    return [];
  }
}
