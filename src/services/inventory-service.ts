import axios, { AxiosInstance } from "axios";
import * as vscode from "vscode";
import { get } from "lodash";
import {
  ApiItem,
  CategorizedInventory,
  DependencyItem,
  SecurityControlItem,
  SensitiveDataItem,
  SourceLocation,
} from "../types/inventory";
import { createApiiroRestApiClient } from "./apiiro-rest-api-provider";

interface InventoryControls {
  sortBy: "name" | "riskLevel";
  sortDirection: "asc" | "desc";
  riskLevelFilter: string[]; // array of selected risk levels
}

export class InventoryService {
  private apiClient: AxiosInstance;
  private static instance: InventoryService;
  private controls: InventoryControls = {
    sortBy: "name",
    sortDirection: "asc",
    riskLevelFilter: ["Critical", "High", "Medium", "Low", "None"],
  };

  private constructor() {
    const token = vscode.workspace.getConfiguration("apiiroCode").get("token");
    this.apiClient = createApiiroRestApiClient("");
  }

  public static getInstance(): InventoryService {
    if (!InventoryService.instance) {
      InventoryService.instance = new InventoryService();
    }
    return InventoryService.instance;
  }

  setControls(controls: Partial<InventoryControls>) {
    this.controls = { ...this.controls, ...controls };
  }

  getControls(): InventoryControls {
    return { ...this.controls };
  }

  private getRiskLevel(item: any): string {
    return get(item, "entity.details.businessImpact", "None");
  }

  private sortItems<
    T extends { name: string; entity: { details: { businessImpact: string } } },
  >(items: T[]): T[] {
    return [...items].sort((a, b) => {
      if (this.controls.sortBy === "name") {
        return this.controls.sortDirection === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      } else {
        const businessImpacts = ["Critical", "High", "Medium", "Low", "None"];
        const aIndex = businessImpacts.indexOf(this.getRiskLevel(a));
        const bIndex = businessImpacts.indexOf(this.getRiskLevel(b));
        return this.controls.sortDirection === "asc"
          ? aIndex - bIndex
          : bIndex - aIndex;
      }
    });
  }

  private filterByRiskLevel<
    T extends { entity: { details: { businessImpact: string } } },
  >(items: T[]): T[] {
    return items.filter((item) =>
      this.controls.riskLevelFilter.includes(this.getRiskLevel(item)),
    );
  }

  async getInventoryData(repoKey: string): Promise<CategorizedInventory> {
    try {
      const response = await this.apiClient.get("/rest-api/v1/inventory", {
        params: {
          "filters[RepositoryID]": repoKey,
          pageSize: 1000,
        },
      });

      const rawData = this.categorizeInventoryItems(response.data.items);

      // Filter and sort items
      const filteredDirect = this.sortItems(
        this.filterByRiskLevel(rawData.dependencies.direct),
      );
      const filteredSub = this.sortItems(
        this.filterByRiskLevel(rawData.dependencies.sub),
      );
      const filteredApis = this.sortItems(
        this.filterByRiskLevel(rawData.apis.items),
      );
      const filteredSensitive = this.sortItems(
        this.filterByRiskLevel(rawData.sensitiveData.items),
      );
      const filteredSecurity = this.sortItems(
        this.filterByRiskLevel(rawData.security.items),
      );

      // Update HTTP method counts after filtering
      const updatedHttpMethodCounts = new Map<string, number>();
      filteredApis.forEach((api) => {
        const httpMethod = api.httpMethod || "UNKNOWN";
        const currentCount = updatedHttpMethodCounts.get(httpMethod) || 0;
        updatedHttpMethodCounts.set(httpMethod, currentCount + 1);
      });

      // Update sensitive data type counts after filtering
      const updatedTypesCounts = new Map<string, number>();
      filteredSensitive.forEach((item) => {
        item.types.forEach((type) => {
          const currentCount = updatedTypesCounts.get(type) || 0;
          updatedTypesCounts.set(type, currentCount + 1);
        });
      });

      return {
        dependencies: {
          direct: filteredDirect,
          sub: filteredSub,
          total: filteredDirect.length + filteredSub.length,
        },
        apis: {
          items: filteredApis,
          total: filteredApis.length,
          byHttpMethod: updatedHttpMethodCounts,
        },
        sensitiveData: {
          items: filteredSensitive,
          total: filteredSensitive.length,
          byType: updatedTypesCounts,
        },
        security: {
          items: filteredSecurity,
          total: filteredSecurity.length,
        },
      };
    } catch (error) {
      console.error("Error fetching inventory data:", error);
      throw new Error("Failed to fetch inventory data");
    }
  }

  private categorizeInventoryItems(items: any[]): CategorizedInventory {
    const categorized: CategorizedInventory = {
      dependencies: {
        direct: [],
        sub: [],
        total: 0,
      },
      apis: {
        items: [],
        total: 0,
        byHttpMethod: new Map(),
      },
      sensitiveData: {
        items: [],
        total: 0,
        byType: new Map(),
      },
      security: {
        items: [],
        total: 0,
      },
    };

    items.forEach((item) => {
      if (item.dependency) {
        if (item.dependencyType === "Direct") {
          categorized.dependencies.direct.push(this.transformDependency(item));
        } else {
          categorized.dependencies.sub.push(this.transformDependency(item));
        }
        categorized.dependencies.total++;
      } else if (item.apiMethodName) {
        const apiItem = this.transformApi(item);
        categorized.apis.items.push(apiItem);
        categorized.apis.total++;

        const httpMethod = item.httpMethod || "UNKNOWN";
        const currentCount = categorized.apis.byHttpMethod.get(httpMethod) || 0;
        categorized.apis.byHttpMethod.set(httpMethod, currentCount + 1);
      } else if (item.sensitiveDataTypes) {
        const sensitiveItem = this.transformSensitiveData(item);
        categorized.sensitiveData.items.push(sensitiveItem);
        categorized.sensitiveData.total++;

        item.sensitiveDataTypes.forEach((type: string) => {
          const currentCount = categorized.sensitiveData.byType.get(type) || 0;
          categorized.sensitiveData.byType.set(type, currentCount + 1);
        });
      }

      if (item.apiSecurityControls) {
        const securityItem = this.transformSecurityControl(item);
        categorized.security.items.push(securityItem);
        categorized.security.total++;
      }
    });

    return categorized;
  }

  private transformDependency(item: any): {
    licenses: any;
    insights: any;
    scope: any;
    name: any;
    sourceLocation: SourceLocation;
    type: any;
    version: any;
    entity: { details: { businessImpact: string } };
  } {
    return {
      name: item.dependency,
      entity: {
        details: {
          businessImpact: get(item, "entity.details.businessImpact", "None"),
        },
      },
      version: item.version,
      type: item.dependencyType,
      scope: item.scope,
      licenses: item.licenses,
      insights: item.insights,
      sourceLocation: this.extractSourceLocation(item),
    };
  }

  private transformApi(item: any): {
    securityControls: any;
    endpoint: any;
    methodSignature: any;
    name: any;
    isPublic: any;
    sourceLocation: SourceLocation;
    httpMethod: any;
    entity: { details: { businessImpact: string } };
  } {
    return {
      name: item.apiMethodName,
      entity: {
        details: {
          businessImpact: get(item, "entity.details.businessImpact", "None"),
        },
      },
      endpoint: item.endpoint,
      httpMethod: item.httpMethod,
      securityControls: item.apiSecurityControls,
      isPublic: item.hasPublicRole,
      sourceLocation: this.extractSourceLocation(item),
      methodSignature: item.methodSignature,
    };
  }

  private transformSensitiveData(item: any): {
    types: any;
    fieldName: any;
    writtenToLogs: any;
    name: any;
    className: any;
    sourceLocation: SourceLocation;
    isExposed: any;
    entity: { details: { businessImpact: string } };
  } {
    return {
      name: item.fieldName,
      entity: {
        details: {
          businessImpact: get(item, "entity.details.businessImpact", "None"),
        },
      },
      fieldName: item.fieldName,
      className: item.className,
      types: item.sensitiveDataTypes,
      isExposed: item.exposedByApi,
      writtenToLogs: item.writtenToLogs,
      sourceLocation: this.extractSourceLocation(item),
    };
  }

  private transformSecurityControl(item: any): {
    endpoint: any;
    name: any;
    sourceLocation: SourceLocation;
    type: any;
    httpMethod: any;
    entity: { details: { businessImpact: string } };
  } {
    const type = item.apiSecurityControls?.join(", ") || "";
    return {
      name: type,
      entity: {
        details: {
          businessImpact: get(item, "entity.details.businessImpact", "None"),
        },
      },
      type: type,
      endpoint: item.endpoint,
      httpMethod: item.httpMethod,
      sourceLocation: this.extractSourceLocation(item),
    };
  }

  private extractSourceLocation(item: any): SourceLocation {
    return {
      filePath: get(item, "sourceCode.filePath", ""),
      lineNumber: get(item, "sourceCode.lineNumber", 0),
      url: get(item, "sourceCode.url", ""),
    };
  }
}

export const inventoryService = InventoryService.getInstance();
