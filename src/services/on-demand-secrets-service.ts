import * as vscode from "vscode";
import * as crypto from "crypto";
import NodeCache from "node-cache";
import { createApiiroRestApiClient } from "./apiiro-rest-api-provider";
import {
  OnDemandSecretsRequest,
  OnDemandSecretsResponse,
  OnDemandSecretItem
} from "../types/local-secret-risk";
import { riskLevels, SecretsRisk } from "../types/risk";

const ON_DEMAND_API_BASE_URL = `/rest-api/v1` as const;

export class OnDemandSecretsService {
  private cache: NodeCache;
  private logger: vscode.OutputChannel;

  constructor() {
    this.logger = vscode.window.createOutputChannel("OnDemandSecrets");
    
    // Initialize cache with 5 minute timeout
    this.cache = new NodeCache({ 
      stdTTL: 300,
      checkperiod: 120 // Check for expired keys every 2 minutes
    });
  }

  /**
   * Main method to scan file for secrets with caching
   */
  async scanFileForSecrets(
    filePath: string,
    fileContent: string,
    repositoryUrl: string
  ): Promise<SecretsRisk[]> {
    try {
      // Check cache first
      const cacheKey = this.getCacheKey(filePath, fileContent);
      const cachedResult = this.cache.get<SecretsRisk[]>(cacheKey);
      if (cachedResult) {
        this.logger.appendLine(`Cache hit for ${filePath}`);
        return cachedResult;
      }

      const results = await this.performScan(filePath, fileContent, repositoryUrl);
      this.cache.set(cacheKey, results);
      return results;
    } catch (error) {
      this.logger.appendLine(`Error scanning ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Perform the actual API scan
   */
  private async performScan(
    filePath: string,
    fileContent: string,
    repositoryUrl: string
  ): Promise<SecretsRisk[]> {
    const apiClient = createApiiroRestApiClient(ON_DEMAND_API_BASE_URL);
    
    if (!apiClient) {
      throw new Error("Failed to create API client - check authentication");
    }

    const request = this.buildScanRequest(filePath, fileContent, repositoryUrl);
    
    this.logger.appendLine(`Scanning ${filePath} for secrets (${fileContent.length} chars)`);
    this.logger.appendLine(`Repository: ${repositoryUrl}`);
    this.logger.appendLine(`API Base URL: ${apiClient.defaults.baseURL}`);
    this.logger.appendLine(`Full request payload: ${JSON.stringify(request)}`);

    // Debug: Log the first 10 lines of file content to verify what we're sending
    const lines = fileContent.split('\n');
    this.logger.appendLine(`=== FILE CONTENT DEBUG (first 10 lines) ===`);
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      this.logger.appendLine(`Line ${i + 1}: ${lines[i]}`);
    }
    this.logger.appendLine(`Total lines: ${lines.length}`);
    this.logger.appendLine(`=== END FILE CONTENT DEBUG ===`);

    const endpoint = '/risks/secrets/on-demand-scan';
    
    try {
      this.logger.appendLine(`POST to: ${apiClient.defaults.baseURL}${endpoint}`);
      
      const response = await apiClient.post<OnDemandSecretsResponse>(
        endpoint,
        request,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      this.logger.appendLine(`✅ Success! Status: ${response.status}`);
      
      if (!response.data || response.data.length === 0) {
        this.logger.appendLine(`No secrets found in ${filePath}`);
        return [];
      }

      // Debug: Log raw API response to check line numbers
      this.logger.appendLine(`=== RAW API RESPONSE DEBUG ===`);
      this.logger.appendLine(`Response data type: ${typeof response.data}`);
      this.logger.appendLine(`Response data length: ${response.data.length}`);
      response.data.forEach((item: any, index: number) => {
        this.logger.appendLine(`Secret ${index}: line ${item.lineNumber}, content: "${item.previewLine}"`);
      });
      this.logger.appendLine(`=== END RAW API RESPONSE DEBUG ===`);

      const localSecrets = this.transformApiResponseToRisks(response.data, filePath);
      
      this.logger.appendLine(
        `Found ${localSecrets.length} local secrets in ${filePath}`
      );

      // Debug: Log transformed secrets
      this.logger.appendLine(`=== TRANSFORMED SECRETS DEBUG ===`);
      localSecrets.forEach((secret, index) => {
        this.logger.appendLine(`Transformed ${index}: line ${secret.sourceCode.lineNumber}, content: "${secret.previewLines[0] || 'N/A'}"`);
      });
      this.logger.appendLine(`=== END TRANSFORMED SECRETS DEBUG ===`);

      return localSecrets;
      
    } catch (error: any) {
      this.logger.appendLine(`❌ Failed: ${error?.response?.status} - ${error?.message}`);
      throw new Error(`API call failed with status ${error?.response?.status || 'unknown'}`);
    }
  }

  /**
   * Transform API response to LocalSecretRisk objects
   */
  private transformApiResponseToRisks(
    response: OnDemandSecretsResponse,
    filePath: string
  ): SecretsRisk[] {
    // Response is directly an array of OnDemandSecretItem
    return response.map((item: OnDemandSecretItem) => this.createSecretRisk(item, filePath));
  }

  /**
   * Create a SecretsRisk from API response item
   */
  private createSecretRisk(item: OnDemandSecretItem, filePath: string): SecretsRisk {
    // Create the local secret risk directly 
    const localSecretRisk: SecretsRisk & { isLocalDetection: boolean } = {
      id: crypto.createHash('md5').update(`${filePath}-${item.lineNumber}-${item.previewLine}`).digest('hex'),
      type: "secrets",
      riskLevel: riskLevels.Medium, // Default to medium for local detections
      riskStatus: "active",
      ruleName: item.secretType,
      riskCategory: "Secrets",
      component: item.secretType,
      discoveredOn: new Date().toISOString(),
      insights: [{
        name: "Local Detection",
        reason: "Detected in local workspace"
      }],
      apiiroRiskUrl: "",
      source: [{
        name: "Local Scan",
        url: null
      }],
      entity: {
        details: {
          branchName: "",
          businessImpact: "Medium",
          isArchived: false,
          key: crypto.createHash('md5').update(`${filePath}-${item.lineNumber}`).digest('hex'),
          monitoringStatus: {
            ignoredBy: null,
            ignoredOn: null,
            ignoreReason: null,
            status: "active"
          },
          name: item.secretType,
          privacySettings: "public",
          profileUrl: "",
          repositoryGroup: "",
          riskLevel: riskLevels.Medium,
          serverUrl: "",
          url: ""
        },
        type: "secret"
      },
      applications: [],
      applicationGroups: [],
      sourceCode: {
        filePath: filePath,
        lineNumber: item.lineNumber,
        url: ""
      },
      contributors: null,
      actionsTaken: null,
      findingCategory: "Secrets",
      findingName: item.secretTypeDescription,
      // SecretsRisk specific properties
      secretType: item.secretType,
      fileType: item.fileType,
      exposure: "unknown",
      validity: "unknown",
      previewLines: [item.previewLine],
      // Local detection marker
      isLocalDetection: true
    };

    return localSecretRisk as SecretsRisk;
  }

  /**
   * Map API validity to risk level
   */
  private mapValidityToRiskLevel(validity: string): any {
    switch (validity.toLowerCase()) {
      case 'valid':
      case 'exposed':
        return riskLevels.High;
      case 'likely_valid':
        return riskLevels.Medium;
      case 'novalidator':
      case 'unknown':
        return riskLevels.Low;
      default:
        return riskLevels.Low;
    }
  }

  /**
   * Map API validity to confidence level
   */
  private mapValidityToConfidence(validity: string): 'high' | 'medium' | 'low' {
    switch (validity.toLowerCase()) {
      case 'valid':
      case 'exposed':
        return 'high';
      case 'likely_valid':
        return 'medium';
      case 'novalidator':
      case 'unknown':
      default:
        return 'low';
    }
  }

  /**
   * Convert SSH git URL to HTTPS format for API compatibility
   */
  private convertToHttpsUrl(gitUrl: string): string {
    // Convert git@github.com:owner/repo.git to https://github.com/owner/repo.git
    if (gitUrl.startsWith('git@')) {
      const sshMatch = gitUrl.match(/git@([^:]+):(.+)/);
      if (sshMatch) {
        const [, hostname, repoPath] = sshMatch;
        return `https://${hostname}/${repoPath}`;
      }
    }
    
    // Already HTTPS or other format, return as-is
    return gitUrl;
  }

  /**
   * Build the scan request payload
   */
  private buildScanRequest(
    filePath: string,
    fileContent: string,
    repositoryUrl: string
  ): OnDemandSecretsRequest {
    // Convert SSH URLs to HTTPS for API compatibility
    const httpsUrl = this.convertToHttpsUrl(repositoryUrl);
    
    this.logger.appendLine(`Original repo URL: ${repositoryUrl}`);
    this.logger.appendLine(`Converted to HTTPS: ${httpsUrl}`);
    
    return {
      RepositoryUrl: httpsUrl,
      FilePath: filePath,
      FileContents: fileContent
    };
  }

  /**
   * Generate cache key based on file path and content
   */
  private getCacheKey(filePath: string, content: string): string {
    const contentHash = crypto.createHash('md5').update(content).digest('hex');
    return `secrets_${filePath}_${contentHash}`;
  }

  /**
   * Handle scan errors gracefully
   */
  private handleScanError(error: any, filePath: string): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.appendLine(`Error scanning ${filePath}: ${errorMessage}`);
    
    // Check if this is an API availability issue
    if (error?.message?.includes('On-demand secrets API not available') || 
        (error?.response?.status === 405) ||
        (error?.response?.status === 404)) {
      
      // Only show this error once per session to avoid spam
      const errorKey = 'on-demand-api-error-shown';
      const hasShownError = this.cache.get(errorKey);
      
      if (!hasShownError) {
        this.cache.set(errorKey, true, 3600); // Remember for 1 hour
        
        vscode.window.showWarningMessage(
          'On-demand secrets scanning is not available. The API endpoint may not be configured. Local secrets detection is disabled.',
          'View Logs',
          'Disable Feature'
        ).then(selection => {
          if (selection === 'View Logs') {
            this.logger.show();
          } else if (selection === 'Disable Feature') {
            vscode.workspace.getConfiguration().update(
              'apiiroCode.secretsOnDemand.enabled', 
              false, 
              vscode.ConfigurationTarget.Global
            );
          }
        });
      }
    }
    


    // Log detailed error but don't propagate to avoid breaking existing functionality
    this.logger.appendLine(`Full error details: ${JSON.stringify({
      message: errorMessage,
      status: error?.response?.status,
      statusText: error?.response?.statusText,
      data: error?.response?.data
    })}`);
  }



  /**
   * Get file extension for metadata
   */
  private getFileExtension(filePath: string): string {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Check if file is binary (should not be scanned)
   */
  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.tar', '.gz', '.rar', '.7z',
      '.exe', '.dll', '.so', '.dylib',
      '.mp3', '.mp4', '.avi', '.mov', '.wav',
      '.ttf', '.woff', '.woff2', '.eot'
    ];
    
    const ext = this.getFileExtension(filePath).toLowerCase();
    return binaryExtensions.includes(`.${ext}`);
  }

  /**
   * Clear all caches
   */
  dispose(): void {
    this.cache.flushAll();
  }

  /**
   * Clear cache for specific file
   */
  clearCacheForFile(filePath: string): void {
    const keys = this.cache.keys().filter(key => key.includes(filePath));
    keys.forEach(key => this.cache.del(key));
  }

  /**
   * Diagnostic method to test API connectivity
   */
  async testApiConnectivity(): Promise<{success: boolean, details: string}> {
    this.logger.appendLine('=== Testing On-Demand Secrets API Connectivity ===');
    
    const apiClient = createApiiroRestApiClient(ON_DEMAND_API_BASE_URL);
    
    if (!apiClient) {
      return {
        success: false,
        details: 'Failed to create API client - check authentication token'
      };
    }

    this.logger.appendLine(`API Base URL: ${apiClient.defaults.baseURL}`);
    this.logger.appendLine(`Authorization Header: ${apiClient.defaults.headers.Authorization ? 'Present' : 'Missing'}`);

    // Test with minimal payload
    const testPayload = {
      RepositoryUrl: 'https://github.com/test/repo.git',
      FilePath: 'test.js',
      FileContents: 'const test = "hello";'
    };

    const endpointVariations = [
      '/risks/secrets/on-demand-scan',
      '/secrets/on-demand-scan', 
      '/risks/secrets/scan',
      '/secrets/scan',
      '/on-demand-scan/secrets'
    ];

    for (const endpoint of endpointVariations) {
      try {
        this.logger.appendLine(`Testing endpoint: ${endpoint}`);
        
        const response = await apiClient.post(endpoint, testPayload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000 // Shorter timeout for testing
        });
        
        this.logger.appendLine(`✅ Success: ${endpoint} returned status ${response.status}`);
        return {
          success: true,
          details: `API is available at endpoint: ${endpoint}`
        };
        
      } catch (error: any) {
        const status = error?.response?.status || 'unknown';
        const statusText = error?.response?.statusText || 'unknown';
        
        this.logger.appendLine(`❌ Failed: ${endpoint} - Status: ${status} (${statusText})`);
        
        if (error?.response?.data) {
          this.logger.appendLine(`Response: ${JSON.stringify(error.response.data)}`);
        }
      }
    }

    return {
      success: false,
      details: 'All endpoint variations failed. The on-demand secrets API may not be available in this environment.'
    };
  }
} 