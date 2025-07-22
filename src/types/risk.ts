export const riskLevels = {
  Critical: "Critical",
  High: "High",
  Medium: "Medium",
  Low: "Low",
} as const;

export type RiskLevel = (typeof riskLevels)[keyof typeof riskLevels];

export const riskCategories = {
  Secrets: "Secrets",
  "OSS Security": "OSS Security",
  "SAST Findings": "SAST Findings",
  "Entry Point Changes": "Entry Point Changes",
  "Sensitive Data": "Sensitive Data",
} as const;

export type RiskCategory = (typeof riskCategories)[keyof typeof riskCategories];

export interface BaseRisk {
  id: string;
  type: string;
  riskLevel: RiskLevel;
  riskStatus: string;
  ruleName: string;
  riskCategory: RiskCategory;
  component: string;
  discoveredOn: string;
  insights: Array<{
    name: string;
    reason: string;
  }>;
  apiiroRiskUrl: string;
  source: Array<{
    name: string;
    url: string | null;
  }>;
  entity: {
    details: {
      branchName: string;
      businessImpact: string;
      isArchived: boolean;
      key: string;
      monitoringStatus: {
        ignoredBy: string | null;
        ignoredOn: string | null;
        ignoreReason: string | null;
        status: string;
      };
      name: string;
      privacySettings: string;
      profileUrl: string;
      repositoryGroup: string;
      riskLevel: RiskLevel;
      serverUrl: string;
      url: string;
    };
    type: string;
  };
  remediationSuggestion?: {
    codeReference: any;
    nearestFixVersion: string;
  };
  applications: Array<{
    apiiroUrl: string;
    businessImpact: string;
    id: string;
    name: string;
  }>;
  applicationGroups: Array<{
    apiiroUrl: string;
    businessImpact: string;
    id: string;
    name: string;
  }>;
  sourceCode: {
    filePath: string;
    lineNumber: number;
    url: string;
  };
  contributors: Array<{
    email: string;
    name: string;
    reason: string;
  }> | null;
  actionsTaken: unknown;
  findingCategory: string;
  findingName: string | null;
}

export interface OSSRisk extends BaseRisk {
  dependencyName: string;
  dependencyVersion: string;
  vulnerabilities?: Array<{
    exploitMaturity: string;
    cvss: number;
    epss?: {
      percentile: number;
      score: number;
      scoreSeverity: string;
    };
    id: string;
    identifiers: string[];
  }>;
  riskCategory: (typeof riskCategories)["OSS Security"];
}

export interface SecretsRisk extends BaseRisk {
  secretType: string;
  fileType: string;
  exposure: string;
  validity: string;
  lastValidatedOn?: string;
  previewLines: string[];
  riskCategory: (typeof riskCategories)["Secrets"];
}

export interface SASTRisk extends BaseRisk {
  issueTitle: string;
  reportUrl: string | null;
  description: string;
  remediationInfo: string;
  type: string;
  cweIdentifiers: string[];
  reportedSecurityFrameworkReferences: any[];
  sources: string[];
  complianceFrameworkReferences: Array<{
    securityComplianceFramework: string;
    identifier: string;
    description: string;
    url: string;
  }>;
  introducedOn: string;
  findingLink: string[];
  findingType: string;
  externalSeverity: string;
  relevantApis: any[];
  riskCategory: (typeof riskCategories)["SAST Findings"];
}

export interface APIRisk extends BaseRisk {
  riskCategory:
    | (typeof riskCategories)["Entry Point Changes"]
    | (typeof riskCategories)["Sensitive Data"];
  httpMethod?: string;
  endpoint?: string;
  apiType?: string;
  authentication?: {
    type: string;
    details: string;
  };
  authorization?: {
    type: string;
    details: string;
  };
  sensitivityPrediction?: {
    score: number;
    confidence: string;
    reasons: string[];
  };
  apiDetails?: {
    parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
    responseFormat: string;
    documentation?: string;
  };
}

export type Risk = OSSRisk | SecretsRisk | SASTRisk | APIRisk;

// Type guard functions
export function isSASTRisk(risk: Risk): risk is SASTRisk {
  return risk.riskCategory === riskCategories["SAST Findings"];
}

export function isOSSRisk(risk: Risk): risk is OSSRisk {
  return risk.riskCategory === riskCategories["OSS Security"];
}

export function isSecretsRisk(risk: Risk): risk is SecretsRisk {
  return risk.riskCategory === riskCategories["Secrets"];
}

export function isAPIRisk(risk: Risk): risk is APIRisk {
  return risk.riskCategory === riskCategories["Entry Point Changes"];
}

export const RISK_CATEGORIES = {
  Runtime: "API Runtime",
  AccessControl: "Access Control",
  DAST: "API Testing",
  BugBounty: "Bug Bounty",
  DataModel: "Data Model Changes",
  EntryPoints: "Entry Point Changes",
  General: "General",
  Infrastructure: "Infrastructure Changes",
  License: "OSS Licenses",
  OSS: "OSS Security",
  PipelineDependencies: "Pipeline Dependencies",
  Secrets: "Secrets",
  SensitiveData: "Sensitive Data",
  SAST: "SAST Findings",
} as const;
