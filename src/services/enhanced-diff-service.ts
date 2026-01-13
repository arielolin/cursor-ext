import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import * as diff from "diff";
import NodeCache from "node-cache";
import { 
  LocalLineChangeInfo, 
  RiskMergeContext, 
  DeduplicationRule, 
  DeduplicationResult
} from "../types/local-secret-risk";
import { Risk, isSecretsRisk } from "../types/risk";
import { Repository } from "../types/repository";
import { runGitCommand } from "./git-service";

const cache = new NodeCache({ stdTTL: 600 }); // 5 minutes cache

// Type guard for local secrets
function isLocalSecretRisk(risk: Risk): boolean {
  return (risk as any).isLocalDetection === true;
}

export class EnhancedDiffService {
  private logger: vscode.OutputChannel;

  constructor() {
    this.logger = vscode.window.createOutputChannel("EnhancedDiffService");
  }

  /**
   * Enhanced line change detection with local secret support
   */
  async detectLineChangesWithLocalSupport(
    lineNumbers: number[],
    repoData: Repository,
    localSecrets: Risk[]
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
   * TWO-PHASE REFACTOR: First position all Apiiro risks (authoritative), then add local secrets (supplementary)
   */
  async mergeRisksWithDeduplication(context: RiskMergeContext): Promise<Map<number, Risk[]>> {
    this.logger.appendLine(`=== SIMPLE MERGE STARTING ===`);
    this.logger.appendLine(`Apiiro risks: ${context.apiiroRisks.length}, Local secrets: ${context.localSecrets.length}`);

    // PHASE 1: Position ALL Apiiro Risks (Authoritative - never filter)
    const apiiroPositions = this.positionApiiroRisks(context.apiiroRisks, context.lineMapping);
    this.logger.appendLine(`Phase 1 complete: ${apiiroPositions.size} lines with Apiiro risks`);

    // PHASE 2: Add Local Secrets with simple deduplication
    const finalRisks = this.addLocalSecretsSimple(context.localSecrets, apiiroPositions);
    this.logger.appendLine(`Phase 2 complete: ${finalRisks.size} total lines with risks`);

    this.logger.appendLine(`=== SIMPLE MERGE COMPLETE ===`);
    return finalRisks;
  }

  /**
   * Create enhanced line mapping with local secret support
   */
  private async createEnhancedLineMapping(
    lineNumbers: number[],
    baseBranchContent: string,
    currentContent: string,
    localSecrets: Risk[],
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
    for (const localSecret of localSecrets) {
      const lineNum = localSecret.sourceCode.lineNumber;
      
      if (!mapping.has(lineNum)) {
        const lineContent = this.getLineContent(editor, lineNum);
        const contentHash = this.generateLineContentHash(editor, lineNum);

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
        // Mark existing mapping as having local risk
        const existing = mapping.get(lineNum)!;
        existing.localOnlyRisk = true;
      }
    }

    return mapping;
  }

  /**
   * Check if two risks are identical (simple comparison)
   */
  private areRisksIdentical(risk1: Risk, risk2: Risk): boolean {
    // For secrets, compare the rule name and risk level
    if (isSecretsRisk(risk1) && isSecretsRisk(risk2)) {
      return risk1.ruleName === risk2.ruleName && 
             risk1.riskLevel === risk2.riskLevel;
    }
    
    // For other risks, compare rule name and risk level
    return risk1.ruleName === risk2.ruleName && 
           risk1.riskLevel === risk2.riskLevel;
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

  /**
   * PHASE 1: Position ALL Apiiro Risks (Authoritative)
   * - Never filter out any Apiiro risks
   * - Smart positioning: follow line moves, show on best available line
   * - These are from server, always trust them
   */
  private positionApiiroRisks(
    apiiroRisks: Risk[],
    lineMapping: Map<number, LocalLineChangeInfo>
  ): Map<number, Risk[]> {
    const positionedRisks = new Map<number, Risk[]>();

    this.logger.appendLine(`=== PHASE 1: POSITIONING APIIRO RISKS ===`);
    this.logger.appendLine(`Processing ${apiiroRisks.length} Apiiro risks`);

    for (const risk of apiiroRisks) {
      const originalLine = risk.sourceCode.lineNumber;
      const lineInfo = lineMapping.get(originalLine);

      this.logger.appendLine(`Apiiro risk ${risk.id} on line ${originalLine}`);

      // Determine best line to show the risk
      let effectiveLine: number;
      
      if (lineInfo?.newLineNum !== null && lineInfo?.newLineNum !== undefined) {
        // Line exists (potentially moved) - use new position
        effectiveLine = lineInfo.newLineNum;
        this.logger.appendLine(`  Line mapped to ${effectiveLine} (${lineInfo.hasMoved ? 'moved' : 'unchanged'})`);
      } else {
        // Line deleted/changed - show on original line anyway (user needs to see it)
        effectiveLine = originalLine;
        this.logger.appendLine(`  Line deleted/changed - showing on original line ${effectiveLine}`);
      }

      // Add to positioned risks
      if (!positionedRisks.has(effectiveLine)) {
        positionedRisks.set(effectiveLine, []);
      }
      positionedRisks.get(effectiveLine)!.push(risk);
      
      this.logger.appendLine(`  Added Apiiro risk to line ${effectiveLine}`);
    }

    this.logger.appendLine(`=== PHASE 1 COMPLETE: ${positionedRisks.size} lines with Apiiro risks ===`);
    return positionedRisks;
  }

  /**
   * PHASE 2: Add Local Secrets with SIMPLE deduplication
   * Rule: Only skip LOCAL secrets if they duplicate a REMOTE secret on same line
   * ALWAYS keep remote secrets, ALWAYS keep unique local secrets
   */
  private addLocalSecretsSimple(
    localSecrets: Risk[],
    apiiroPositions: Map<number, Risk[]>
  ): Map<number, Risk[]> {
    // Start with ALL Apiiro positions (never remove these)
    const finalRisks = new Map<number, Risk[]>();
    
    // Copy all Apiiro positions first - these are NEVER removed
    for (const [lineNum, risks] of apiiroPositions) {
      finalRisks.set(lineNum, [...risks]);
    }

    this.logger.appendLine(`=== PHASE 2: ADDING LOCAL SECRETS (SUPER SIMPLE) ===`);
    this.logger.appendLine(`Processing ${localSecrets.length} local secrets`);
    this.logger.appendLine(`Remote risks already present on ${apiiroPositions.size} lines`);

    for (const localSecret of localSecrets) {
      const lineNumber = localSecret.sourceCode.lineNumber;
      this.logger.appendLine(`Local secret ${localSecret.id} on line ${lineNumber}`);

      // SIMPLE RULE: If ANY remote risk exists on this line, skip the local secret
      const hasAnyRemoteRiskOnLine = apiiroPositions.has(lineNumber);

      if (hasAnyRemoteRiskOnLine) {
        this.logger.appendLine(`  Skipping LOCAL secret: remote risk exists on line ${lineNumber} (simple deduplication)`);
        continue;
      }

      // Add local secret (no remote risks on this line)
      this.logger.appendLine(`  Adding LOCAL secret to line ${lineNumber} (no remote risks on this line)`);
      
      if (!finalRisks.has(lineNumber)) {
        finalRisks.set(lineNumber, []);
      }
      finalRisks.get(lineNumber)!.push(localSecret);
    }

    this.logger.appendLine(`=== PHASE 2 COMPLETE: ${finalRisks.size} total lines with risks ===`);
    
    // Log final summary
    let totalRemote = 0;
    let totalLocal = 0;
    for (const [lineNum, risks] of finalRisks) {
      const remoteCount = risks.filter(r => !isLocalSecretRisk(r)).length;
      const localCount = risks.filter(r => isLocalSecretRisk(r)).length;
      totalRemote += remoteCount;
      totalLocal += localCount;
      this.logger.appendLine(`  Line ${lineNum}: ${remoteCount} remote + ${localCount} local = ${risks.length} total`);
    }
    this.logger.appendLine(`FINAL TOTALS: ${totalRemote} remote secrets + ${totalLocal} local secrets = ${totalRemote + totalLocal} total`);
    
    return finalRisks;
  }
} 