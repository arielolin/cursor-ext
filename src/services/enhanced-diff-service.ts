import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import * as diff from "diff";
import NodeCache from "node-cache";
import { 
  LocalLineChangeInfo, 
  RiskMergeContext, 
  DeduplicationRule, 
  DeduplicationResult,
  LocalSecretRisk,
  isLocalSecretRisk,
  isSecretsCategory
} from "../types/local-secret-risk";
import { Risk, isSecretsRisk } from "../types/risk";
import { Repository } from "../types/repository";
import { runGitCommand } from "./git-service";

const cache = new NodeCache({ stdTTL: 600 }); // 5 minutes cache

export class EnhancedDiffService {
  private logger: vscode.OutputChannel;
  private deduplicationRules: DeduplicationRule[] = [];

  constructor() {
    this.logger = vscode.window.createOutputChannel("EnhancedDiffService");
    this.initializeDeduplicationRules();
  }

  /**
   * Enhanced line change detection with local secret support
   */
  async detectLineChangesWithLocalSupport(
    lineNumbers: number[],
    repoData: Repository,
    localSecrets: LocalSecretRisk[]
  ): Promise<Map<number, LocalLineChangeInfo>> {
    this.logger.appendLine(`Detecting line changes for ${lineNumbers.length} lines with ${localSecrets.length} local secrets`);

    const baseBranch = repoData.branchName;
    if (!baseBranch) {
      return this.createErrorResult(lineNumbers, ["Repository data is missing or incomplete"]);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return this.createErrorResult(lineNumbers, ["No active text editor"]);
    }

    const document = editor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return this.createErrorResult(lineNumbers, ["File is not part of a workspace"]);
    }

    try {
      const workspacePath = workspaceFolder.uri.fsPath;
      const absoluteFilePath = document.uri.fsPath;
      const relativeFilePath = path.relative(workspacePath, absoluteFilePath);

      // Fetch the latest changes (cached to avoid repeated calls)
      await this.ensureGitFetch(workspacePath);

      // Get base branch content
      const baseBranchContent = await this.getBaseBranchContent(
        workspacePath, 
        baseBranch, 
        relativeFilePath
      );

      // Get current content
      const currentContent = document.getText();

      // Create enhanced line mapping
      const enhancedMapping = await this.createEnhancedLineMapping(
        lineNumbers,
        baseBranchContent,
        currentContent,
        localSecrets,
        editor
      );

      this.logger.appendLine(`Created enhanced mapping for ${enhancedMapping.size} lines`);
      return enhancedMapping;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.appendLine(`Error in enhanced diff detection: ${errorMessage}`);
      return this.createErrorResult(lineNumbers, [errorMessage]);
    }
  }

  /**
   * Merge risks with intelligent deduplication
   */
  async mergeRisksWithDeduplication(context: RiskMergeContext): Promise<Map<number, Risk[]>> {
    this.logger.appendLine(`Merging ${context.apiiroRisks.length} Apiiro risks with ${context.localSecrets.length} local secrets`);

    // Separate secrets from other risks for targeted deduplication
    const apiiroSecrets = context.apiiroRisks.filter(isSecretsRisk);
    const otherApiiroRisks = context.apiiroRisks.filter(risk => !isSecretsRisk(risk));

    // Perform deduplication on secrets only
    const deduplicationResult = this.deduplicateSecrets(apiiroSecrets, context.localSecrets);

    // Log deduplication results
    this.logger.appendLine(`Deduplication found ${deduplicationResult.duplicates.length} duplicates`);
    deduplicationResult.duplicates.forEach(dup => {
      this.logger.appendLine(`  Duplicate: Apiiro(${dup.apiiroRisk.id}) <-> Local(${dup.localRisk.id}) via ${dup.rule.type} (confidence: ${dup.confidence})`);
    });

    // Combine all non-duplicate risks + preferred risks from duplicates (Apiiro over local)
    const preferredFromDuplicates = deduplicationResult.duplicates.map(dup => dup.apiiroRisk);
    
    const finalRisks: Risk[] = [
      ...otherApiiroRisks,
      ...deduplicationResult.apiiroRisks,
      ...deduplicationResult.localSecrets,
      ...preferredFromDuplicates // Add back the preferred Apiiro risks from duplicates
    ];

    this.logger.appendLine(`=== FINAL RISK COMBINATION ===`);
    this.logger.appendLine(`Other Apiiro risks: ${otherApiiroRisks.length}`);
    this.logger.appendLine(`Deduplicated Apiiro risks: ${deduplicationResult.apiiroRisks.length}`);
    this.logger.appendLine(`Deduplicated local secrets: ${deduplicationResult.localSecrets.length}`);
    this.logger.appendLine(`Preferred from duplicates: ${preferredFromDuplicates.length}`);
    this.logger.appendLine(`Total final risks: ${finalRisks.length}`);
    
    // Log each final risk
    finalRisks.forEach((risk, index) => {
      this.logger.appendLine(`  Risk ${index}: ${risk.id} on line ${risk.sourceCode.lineNumber} (isLocal: ${isLocalSecretRisk(risk)})`);
    });

    // Group by line number using enhanced line mapping
    const groupedRisks = this.groupRisksByLine(finalRisks, context.lineMapping);

    this.logger.appendLine(`Final grouped risks: ${Array.from(groupedRisks.keys()).length} lines with risks`);
    return groupedRisks;
  }

  /**
   * Deduplicate secrets between Apiiro and local detection
   */
  private deduplicateSecrets(
    apiiroSecrets: Risk[],
    localSecrets: LocalSecretRisk[]
  ): DeduplicationResult {
    const result: DeduplicationResult = {
      apiiroRisks: [...apiiroSecrets],
      localSecrets: [...localSecrets],
      duplicates: []
    };

    // Track which risks have been matched
    const matchedApiiroIndices = new Set<number>();
    const matchedLocalIndices = new Set<number>();

    // Apply deduplication rules in order of confidence
    for (const rule of this.deduplicationRules) {
      for (let apiiroIndex = 0; apiiroIndex < apiiroSecrets.length; apiiroIndex++) {
        if (matchedApiiroIndices.has(apiiroIndex)) continue;

        const apiiroRisk = apiiroSecrets[apiiroIndex];
        
        for (let localIndex = 0; localIndex < localSecrets.length; localIndex++) {
          if (matchedLocalIndices.has(localIndex)) continue;

          const localRisk = localSecrets[localIndex];

          if (rule.matcher(apiiroRisk, localRisk)) {
            // Found a match - prefer Apiiro risk (more metadata)
            result.duplicates.push({
              apiiroRisk,
              localRisk,
              rule,
              confidence: rule.confidence
            });

            matchedApiiroIndices.add(apiiroIndex);
            matchedLocalIndices.add(localIndex);
            break;
          }
        }
      }
    }

    // Remove matched risks from the final arrays
    result.apiiroRisks = apiiroSecrets.filter((_, index) => !matchedApiiroIndices.has(index));
    result.localSecrets = localSecrets.filter((_, index) => !matchedLocalIndices.has(index));

    return result;
  }

  /**
   * Initialize sophisticated deduplication rules
   */
  private initializeDeduplicationRules(): void {
    this.deduplicationRules = [
      // Exact line and content match
      {
        type: 'exact',
        confidence: 1.0,
        matcher: (apiiro, local) => 
          apiiro.sourceCode.lineNumber === local.sourceCode.lineNumber &&
          this.extractSecretValue(apiiro) === this.extractSecretValue(local)
      },

      // Same line, similar secret content
      {
        type: 'content',
        confidence: 0.9,
        matcher: (apiiro, local) =>
          apiiro.sourceCode.lineNumber === local.sourceCode.lineNumber &&
          this.calculateStringSimilarity(
            this.extractSecretValue(apiiro),
            this.extractSecretValue(local)
          ) > 0.85
      },

      // Nearby lines (±2), exact content match
      {
        type: 'fuzzy',
        confidence: 0.8,
        matcher: (apiiro, local) =>
          Math.abs(apiiro.sourceCode.lineNumber - local.sourceCode.lineNumber) <= 2 &&
          this.extractSecretValue(apiiro) === this.extractSecretValue(local)
      },

      // Same secret pattern/type, nearby lines
      {
        type: 'pattern',
        confidence: 0.7,
        matcher: (apiiro, local) => {
          const apiiroSecretType = isSecretsRisk(apiiro) ? apiiro.secretType : '';
          const localSecretType = local.secretType;
          
          return Math.abs(apiiro.sourceCode.lineNumber - local.sourceCode.lineNumber) <= 3 &&
                 apiiroSecretType === localSecretType &&
                 this.calculateStringSimilarity(
                   this.extractSecretValue(apiiro),
                   this.extractSecretValue(local)
                 ) > 0.7;
        }
      },

      // Content hash match (if available)
      {
        type: 'content',
        confidence: 0.95,
        matcher: (apiiro, local) =>
          !!local.contentHash &&
          local.contentHash === this.generateContentHash(this.extractSecretValue(apiiro))
      }
    ];

    // Sort by confidence (highest first)
    this.deduplicationRules.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Create enhanced line mapping with local secret support
   */
  private async createEnhancedLineMapping(
    lineNumbers: number[],
    baseBranchContent: string,
    currentContent: string,
    localSecrets: LocalSecretRisk[],
    editor: vscode.TextEditor
  ): Promise<Map<number, LocalLineChangeInfo>> {
    const mapping = new Map<number, LocalLineChangeInfo>();

    // Handle case where base branch content is empty (new file)
    if (!baseBranchContent) {
      for (const lineNum of lineNumbers) {
        mapping.set(lineNum, {
          originalLineNumber: lineNum,
          hasChanged: false, // New file, so not "changed" per se
          hasMoved: false,
          newLineNum: lineNum,
          errors: [],
          isNewContent: true,
          contentHash: this.generateLineContentHash(editor, lineNum),
          lineContent: this.getLineContent(editor, lineNum),
          localOnlyRisk: true
        });
      }
      return mapping;
    }

    // Calculate diff for existing files
    const diffResult = diff.structuredPatch(
      "base",
      "current", 
      baseBranchContent,
      currentContent,
      "",
      ""
    );

    // Create line mapping from diff
    const lineMapping = this.buildLineMapping(diffResult, baseBranchContent);

    // Process each line number
    for (const lineNum of lineNumbers) {
      const newLineNum = lineMapping.get(lineNum);
      const lineContent = this.getLineContent(editor, lineNum);
      const contentHash = this.generateLineContentHash(editor, lineNum);

      // Check if this line has local-only secrets
      const hasLocalSecret = localSecrets.some(secret => 
        secret.sourceCode.lineNumber === lineNum
      );

      if (newLineNum === undefined) {
        // Line was removed/changed
        mapping.set(lineNum, {
          originalLineNumber: lineNum,
          hasChanged: true,
          hasMoved: false,
          newLineNum: null,
          errors: [],
          isNewContent: false,
          contentHash,
          lineContent,
          localOnlyRisk: hasLocalSecret
        });
      } else {
        // Line exists (potentially moved)
        mapping.set(lineNum, {
          originalLineNumber: lineNum,
          hasChanged: false,
          hasMoved: newLineNum !== lineNum,
          newLineNum,
          errors: [],
          isNewContent: false,
          contentHash,
          lineContent,
          localOnlyRisk: hasLocalSecret
        });
      }
    }

    // Handle local secrets that might be on new lines
    this.logger.appendLine(`=== PROCESSING LOCAL SECRETS ===`);
    this.logger.appendLine(`Editor document has ${editor.document.lineCount} lines`);
    
    for (const localSecret of localSecrets) {
      const lineNum = localSecret.sourceCode.lineNumber;
      this.logger.appendLine(`Processing local secret ${localSecret.id} on line ${lineNum}`);
      this.logger.appendLine(`  Secret content from API: "${localSecret.lineContent}"`);
      
      if (!mapping.has(lineNum)) {
        const lineContent = this.getLineContent(editor, lineNum);
        const contentHash = this.generateLineContentHash(editor, lineNum);

        this.logger.appendLine(`  Adding new mapping for line ${lineNum}`);
        this.logger.appendLine(`  Editor line content: "${lineContent}"`);
        this.logger.appendLine(`  API line content: "${localSecret.lineContent}"`);
        this.logger.appendLine(`  Content match: ${lineContent === localSecret.lineContent}`);

        mapping.set(lineNum, {
          originalLineNumber: lineNum,
          hasChanged: false,
          hasMoved: false,
          newLineNum: lineNum,
          errors: [],
          isNewContent: !lineMapping.has(lineNum), // New line if not in base mapping
          contentHash,
          lineContent,
          localOnlyRisk: true
        });
      } else {
        this.logger.appendLine(`  Line ${lineNum} already has mapping`);
        // Mark existing mapping as having local risk
        const existing = mapping.get(lineNum)!;
        existing.localOnlyRisk = true;
        this.logger.appendLine(`  Existing line content: "${existing.lineContent}"`);
        this.logger.appendLine(`  API line content: "${localSecret.lineContent}"`);
      }
    }
    this.logger.appendLine(`=== END PROCESSING LOCAL SECRETS ===`);

    return mapping;
  }

  /**
   * Group risks by line number with enhanced mapping validation
   */
  private groupRisksByLine(
    risks: Risk[],
    lineMapping: Map<number, LocalLineChangeInfo>
  ): Map<number, Risk[]> {
    const groupedRisks = new Map<number, Risk[]>();

    this.logger.appendLine(`=== GROUPING RISKS BY LINE ===`);
    this.logger.appendLine(`Processing ${risks.length} risks`);

    for (const risk of risks) {
      const lineNumber = risk.sourceCode.lineNumber;
      const lineInfo = lineMapping.get(lineNumber);
      const isLocal = isLocalSecretRisk(risk);

      this.logger.appendLine(`Risk ${risk.id} on line ${lineNumber}: isLocal=${isLocal}, hasLineInfo=${!!lineInfo}`);

      // Skip risks on lines that have changed (unless they're local-only)
      if (lineInfo?.hasChanged && !isLocalSecretRisk(risk)) {
        this.logger.appendLine(`  Skipping: line changed and not local`);
        continue;
      }

      // For local secrets, validate line content matches
      if (isLocalSecretRisk(risk) && lineInfo) {
        const isValid = this.validateLocalSecretLine(risk, lineInfo);
        this.logger.appendLine(`  Local secret validation: ${isValid}`);
        if (!isValid) {
          this.logger.appendLine(`  Skipping: local secret validation failed`);
          continue;
        }
      }

      // Local secrets should use their original line numbers since they're detected from current content
      const effectiveLineNumber = isLocalSecretRisk(risk) 
        ? lineNumber  // Use original line number for local secrets
        : (lineInfo?.newLineNum ?? lineNumber); // Use mapped line for Apiiro risks
      
      this.logger.appendLine(`  Original line: ${lineNumber}, Mapped line: ${lineInfo?.newLineNum ?? 'N/A'}, Effective line: ${effectiveLineNumber}`);
      this.logger.appendLine(`  Using ${isLocalSecretRisk(risk) ? 'ORIGINAL' : 'MAPPED'} line number for ${isLocalSecretRisk(risk) ? 'LOCAL' : 'APIIRO'} risk`);
      
      if (!groupedRisks.has(effectiveLineNumber)) {
        groupedRisks.set(effectiveLineNumber, []);
      }
      
      groupedRisks.get(effectiveLineNumber)!.push(risk);
    }

    this.logger.appendLine(`=== GROUPING COMPLETE: ${groupedRisks.size} lines with risks ===`);
    return groupedRisks;
  }

  /**
   * Validate that local secret still matches the current line content
   */
  private validateLocalSecretLine(
    localSecret: LocalSecretRisk,
    lineInfo: LocalLineChangeInfo
  ): boolean {
    this.logger.appendLine(`    === LOCAL SECRET VALIDATION ===`);
    this.logger.appendLine(`    Secret ID: ${localSecret.id}`);
    this.logger.appendLine(`    Line content available: ${!!lineInfo.lineContent}`);
    this.logger.appendLine(`    Local secret content available: ${!!localSecret.lineContent}`);

    // For local secrets, be very lenient since they were just detected
    // Only reject if the line is completely different or empty
    
    if (!lineInfo.lineContent) {
      this.logger.appendLine(`    No current line content, returning true anyway`);
      return true; // Line might be new or moved, still show the risk
    }

    if (!localSecret.lineContent) {
      this.logger.appendLine(`    No local secret content, returning true`);
      return true; // Can't validate, assume valid
    }

    // Very basic validation - just check if it's not a completely different line
    const similarity = this.calculateStringSimilarity(lineInfo.lineContent, localSecret.lineContent);
    
    this.logger.appendLine(`    Current line: "${lineInfo.lineContent}"`);
    this.logger.appendLine(`    Local line: "${localSecret.lineContent}"`);
    this.logger.appendLine(`    Similarity: ${similarity.toFixed(3)}`);

    // Be very lenient for local secrets - only reject if similarity is extremely low
    const isValid = similarity > 0.3; // Much lower threshold
    
    this.logger.appendLine(`    Final validation result: ${isValid} (lenient for local secrets)`);
    this.logger.appendLine(`    === END LOCAL SECRET VALIDATION ===`);

    return isValid;
  }

  /**
   * Extract secret value from risk for comparison
   */
  private extractSecretValue(risk: Risk): string {
    if (isSecretsRisk(risk)) {
      return risk.component || risk.entity.details.name || '';
    }
    return risk.component || '';
  }

  /**
   * Calculate string similarity (simple Levenshtein-based)
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator  // substitution
        );
      }
    }

    const maxLength = Math.max(str1.length, str2.length);
    return (maxLength - matrix[str2.length][str1.length]) / maxLength;
  }

  /**
   * Utility functions
   */
  private async ensureGitFetch(workspacePath: string): Promise<void> {
    const fetchKey = "fetchOrigin";
    if (!cache.get(fetchKey)) {
      await runGitCommand(workspacePath, ["fetch", "origin"]);
      cache.set(fetchKey, true);
    }
  }

  private async getBaseBranchContent(
    workspacePath: string,
    baseBranch: string,
    relativeFilePath: string
  ): Promise<string> {
    try {
      return await runGitCommand(workspacePath, [
        "show",
        `origin/${baseBranch}:${relativeFilePath}`
      ]);
    } catch (error) {
      this.logger.appendLine(`Warning: Could not fetch base branch content: ${error}`);
      return "";
    }
  }

  private buildLineMapping(diffResult: any, baseBranchContent: string): Map<number, number> {
    const lineMapping = new Map<number, number>();
    let currentOldLine = 1;
    let currentNewLine = 1;

    for (const hunk of diffResult.hunks) {
      // Map unchanged lines before the hunk
      while (currentOldLine < hunk.oldStart) {
        lineMapping.set(currentOldLine, currentNewLine);
        currentOldLine++;
        currentNewLine++;
      }

      for (const line of hunk.lines) {
        if (line.startsWith("-")) {
          currentOldLine++;
        } else if (line.startsWith("+")) {
          currentNewLine++;
        } else {
          lineMapping.set(currentOldLine, currentNewLine);
          currentOldLine++;
          currentNewLine++;
        }
      }
    }

    // Map remaining unchanged lines
    const totalBaseLines = baseBranchContent.split("\n").length;
    while (currentOldLine <= totalBaseLines) {
      lineMapping.set(currentOldLine, currentNewLine);
      currentOldLine++;
      currentNewLine++;
    }

    return lineMapping;
  }

  private getLineContent(editor: vscode.TextEditor, lineNumber: number): string {
    try {
      if (lineNumber > 0 && lineNumber <= editor.document.lineCount) {
        return editor.document.lineAt(lineNumber - 1).text;
      }
    } catch (error) {
      // Line doesn't exist
    }
    return "";
  }

  private generateLineContentHash(editor: vscode.TextEditor, lineNumber: number): string {
    const content = this.getLineContent(editor, lineNumber);
    return this.generateContentHash(content);
  }

  private generateContentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private createErrorResult(
    lineNumbers: number[],
    errors: string[]
  ): Map<number, LocalLineChangeInfo> {
    const result = new Map<number, LocalLineChangeInfo>();
    
    for (const lineNum of lineNumbers) {
      result.set(lineNum, {
        originalLineNumber: lineNum,
        hasChanged: false,
        hasMoved: false,
        newLineNum: lineNum,
        errors,
        isNewContent: false,
        localOnlyRisk: false
      });
    }
    
    return result;
  }
} 