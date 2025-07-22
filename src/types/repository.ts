export interface Repository {
  branchName: string;
  isArchived: boolean;
  isPublic: boolean;
  key: string;
  languages: string[];
  name: string;
  projectId: string;
  provider: string;
  riskLevel: string;
  scmRepositoryKey: string;
  serverUrl: string;
  url: string;
}
