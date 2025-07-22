// types/inventory.ts

export interface SourceLocation {
  filePath: string;
  lineNumber: number;
  url: string;
}

// Base interface for common fields
interface BaseItem {
  name: string;
  entity: {
    details: {
      businessImpact: string;
    };
  };
  sourceLocation: SourceLocation;
}

export interface DependencyItem extends BaseItem {
  version: string;
  type: string;
  scope: string;
  licenses: Array<{ name: string; url: string | null }>;
  insights: Array<{ name: string; reason: string }>;
}

export interface ApiItem extends BaseItem {
  endpoint: string;
  httpMethod: string;
  securityControls: string[];
  isPublic: boolean;
  methodSignature: string;
}

export interface SensitiveDataItem extends BaseItem {
  fieldName: string;
  className: string;
  types: string[];
  isExposed: boolean;
  writtenToLogs: boolean;
}

export interface SecurityControlItem extends BaseItem {
  type: string;
  endpoint: string;
  httpMethod: string;
}

export interface CategorizedInventory {
  dependencies: {
    direct: DependencyItem[];
    sub: DependencyItem[];
    total: number;
  };
  apis: {
    items: ApiItem[];
    total: number;
    byHttpMethod: Map<string, number>;
  };
  sensitiveData: {
    items: SensitiveDataItem[];
    total: number;
    byType: Map<string, number>;
  };
  security: {
    items: SecurityControlItem[];
    total: number;
  };
}
