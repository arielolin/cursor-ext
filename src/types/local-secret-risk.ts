import { Risk } from "./risk";

/**
 * Enhanced line change information 
 */
export interface LocalLineChangeInfo {
  originalLineNumber: number;
  hasChanged: boolean;
  hasMoved: boolean;
  newLineNum: number | null;
  errors: string[];
  isNewContent: boolean;
  contentHash?: string;
  lineContent?: string;
  localOnlyRisk: boolean;
}

/**
 * Context for risk merging and deduplication
 */
export interface RiskMergeContext {
  apiiroRisks: Risk[];
  localSecrets: Risk[];
  lineMapping: Map<number, LocalLineChangeInfo>;
}

/**
 * Deduplication rule for comparing risks
 */
export interface DeduplicationRule {
  type: 'exact' | 'content' | 'fuzzy' | 'pattern' | 'content_hash' | 'same_line_similar';
  confidence: number;
  matcher: (apiiroRisk: Risk, localRisk: Risk) => boolean;
}

/**
 * Result of deduplication process
 */
export interface DeduplicationResult {
  apiiroRisks: Risk[];
  localSecrets: Risk[];
  duplicates: Array<{
    apiiroRisk: Risk;
    localRisk: Risk;
    rule: DeduplicationRule;
    confidence: number;
  }>;
}

/**
 * Type guard to check if a risk is a local detection
 */
export function isLocalSecretRisk(risk: Risk): boolean {
  return (risk as any).isLocalDetection === true;
}

// API types for on-demand scanning service
export interface OnDemandSecretsRequest {
  RepositoryUrl: string;
  FilePath: string;
  FileContents: string;
}

export type OnDemandSecretsResponse = OnDemandSecretItem[];

export interface OnDemandSecretItem {
  secretType: string;
  secretTypeDescription: string;
  lineNumber: number;
  previewLine: string;
  fileType: string;
} 