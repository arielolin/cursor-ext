// src/features/risk-highlighter/risk-highlighter.ts
import * as vscode from "vscode";
import {
  OSSRisk,
  Risk,
  riskLevels,
  SASTRisk,
  SecretsRisk,
} from "../../types/risk";
import { getRelativeFilePath } from "../../utils/vs-code";
import { Repository } from "../../types/repository";
import { RiskRemediationTriggerCodeLensProvider } from "../remediate-risks/remediation-trigger-code-lense";
import { DiagnosticsHelper } from "./problems-panel";
import { DecorationHelper } from "./decoration-helper";

import { createOSSMessage } from "./create-hover-message/oss-hover-message";
import { createSecretsMessage } from "./create-hover-message/secrets-hover-message";
import { createDefaultMessage } from "./create-hover-message/default-hover-message";
import { createSastHoverMessage } from "./create-hover-message/sast-hover-message";
import { createApiHoverMessage } from "./create-hover-message/api-hover-message";
import { createLocalSecretsMessage, createLocalSecretsCondensedMessage } from "./create-hover-message/local-secrets-hover-message";
import { detectLineChanges } from "../../services/diff-service";
import { findRisksForFile } from "../../services/file-risk-service";

// New imports for local secrets functionality
import { OnDemandSecretsService } from "../../services/on-demand-secrets-service";
import { EnhancedDiffService } from "../../services/enhanced-diff-service";
import { getRemoteUrl } from "../../services/git-service";

// Type guard for local secrets
function isLocalSecretRisk(risk: Risk): boolean {
  return (risk as any).isLocalDetection === true;
}

export class RiskHighlighter {
  private readonly decorationTypes: Map<
    string,
    vscode.TextEditorDecorationType
  >;
  private readonly localDecorationTypes: Map<
    string,
    vscode.TextEditorDecorationType
  >;
  private readonly diagnosticsHelper: DiagnosticsHelper;
  private readonly remediationTriggerProvider: RiskRemediationTriggerCodeLensProvider;
  
  // New services for local secrets functionality
  private readonly onDemandSecretsService: OnDemandSecretsService;
  private readonly enhancedDiffService: EnhancedDiffService;
  private isLocalSecretsEnabled: boolean;

  // Output channel for logging
  private readonly outputChannel: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext) {
    // Create output channel for logging
    this.outputChannel = vscode.window.createOutputChannel("Risk Highlights");
    this.outputChannel.appendLine("[RiskHighlighter] Constructor: Initializing RiskHighlighter");
    
    // Create standard decorations for Apiiro risks
    this.decorationTypes = new Map([
      [
        riskLevels.Critical,
        DecorationHelper.createDecoration(riskLevels.Critical),
      ],
      [riskLevels.High, DecorationHelper.createDecoration(riskLevels.High)],
      [riskLevels.Medium, DecorationHelper.createDecoration(riskLevels.Medium)],
      [riskLevels.Low, DecorationHelper.createDecoration(riskLevels.Low)],
    ]);

    // Create distinct decorations for local secrets
    this.localDecorationTypes = new Map([
      [
        riskLevels.Critical,
        DecorationHelper.createLocalDecoration(riskLevels.Critical),
      ],
      [riskLevels.High, DecorationHelper.createLocalDecoration(riskLevels.High)],
      [riskLevels.Medium, DecorationHelper.createLocalDecoration(riskLevels.Medium)],
      [riskLevels.Low, DecorationHelper.createLocalDecoration(riskLevels.Low)],
    ]);

    this.diagnosticsHelper = new DiagnosticsHelper();
    this.remediationTriggerProvider =
      new RiskRemediationTriggerCodeLensProvider();

    // Initialize new services
    this.outputChannel.appendLine("[RiskHighlighter] Constructor: Initializing OnDemandSecretsService");
    this.onDemandSecretsService = new OnDemandSecretsService();
    this.outputChannel.appendLine("[RiskHighlighter] Constructor: Initializing EnhancedDiffService");
    this.enhancedDiffService = new EnhancedDiffService();
    
    // Check if local secrets scanning is enabled
    this.isLocalSecretsEnabled = this.getLocalSecretsConfig();
    this.outputChannel.appendLine(`[RiskHighlighter] Constructor: Local secrets enabled: ${this.isLocalSecretsEnabled}`);

    context.subscriptions.push(
      ...Array.from(this.decorationTypes.values()),
      ...Array.from(this.localDecorationTypes.values()),
      this.diagnosticsHelper,
      this.onDemandSecretsService,
      this.outputChannel, // Add output channel to subscriptions for cleanup
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        this.remediationTriggerProvider,
      ),
      // Listen for configuration changes
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("apiiroCode.secretsOnDemand")) {
          const oldValue = this.isLocalSecretsEnabled;
          this.isLocalSecretsEnabled = this.getLocalSecretsConfig();
          this.outputChannel.appendLine(`[RiskHighlighter] Config change: Local secrets enabled changed from ${oldValue} to ${this.isLocalSecretsEnabled}`);
        }
      })
    );
    
    this.outputChannel.appendLine("[RiskHighlighter] Constructor: Initialization complete");
  }

  /**
   * Get local secrets configuration from VS Code settings
   */
  private getLocalSecretsConfig(): boolean {
    const config = vscode.workspace.getConfiguration("apiiroCode.secretsOnDemand");
    const enabled = config.get("enabled", true);
    this.outputChannel.appendLine(`[RiskHighlighter] getLocalSecretsConfig: Retrieved config value: ${enabled}`);
    return enabled;
  }

  /**
   * Lightweight highlighting for text changes - only Apiiro risks, no local secrets
   * PRESERVES existing local secret highlights
   */
  public async highlightApiiroRisksOnly(
    editor: vscode.TextEditor,
    repoData: Repository,
  ): Promise<void> {
    this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Starting for file ${editor.document.fileName}`);
    
    try {
      const relativeFilePath = getRelativeFilePath(editor);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Relative file path: ${relativeFilePath}`);
      
      if (!relativeFilePath) {
        this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: No relative file path, returning");
        return;
      }

      // Only fetch Apiiro risks for fast highlighting during text changes
      this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: Fetching Apiiro risks");
      const apiiroRisks = await findRisksForFile(relativeFilePath, repoData);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Found ${apiiroRisks.length} Apiiro risks`);

      if (apiiroRisks.length === 0) {
        this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: No Apiiro risks found, preserving existing highlights");
        // Don't remove highlights - this preserves local secrets
        return;
      }

      // Use simple line change detection (not enhanced)
      const lineNumbers = apiiroRisks.map(r => r.sourceCode.lineNumber);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Detecting line changes for lines: ${lineNumbers.join(', ')}`);
      const lineChanges = await detectLineChanges(lineNumbers, repoData);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Line changes detected: ${lineChanges.length} results`);
      
      const groupedRisks = new Map<number, Risk[]>();
      
      for (const risk of apiiroRisks) {
        const lineNum = risk.sourceCode.lineNumber;
        const lineChange = lineChanges.find(change => change.originalLineNumber === lineNum);
        
        // Skip risks on changed lines
        if (lineChange?.hasChanged) {
          this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Skipping risk on changed line ${lineNum}`);
          continue;
        }
        
        const effectiveLineNumber = lineChange?.newLineNum ?? lineNum;
        this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Adding risk to line ${effectiveLineNumber} (original: ${lineNum})`);
        
        if (!groupedRisks.has(effectiveLineNumber)) {
          groupedRisks.set(effectiveLineNumber, []);
        }
        
        groupedRisks.get(effectiveLineNumber)!.push(risk);
      }

      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Grouped risks by ${groupedRisks.size} lines`);
      this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: Applying inline highlights");
      await this.applyInlineHighlights(editor, groupedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: Updating remediation triggers");
      this.remediationTriggerProvider.updateRemediationTriggers(groupedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: Updating diagnostics");
      this.diagnosticsHelper.updateDiagnostics(editor, groupedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightApiiroRisksOnly: Completed successfully");
    } catch (error) {
      this.outputChannel.appendLine(`[RiskHighlighter] highlightApiiroRisksOnly: Error occurred: ${error}`);
    }
  }

  public async highlightRisksForActiveFile(
    editor: vscode.TextEditor,
    repoData: Repository,
    includeLocalSecrets: boolean = true
  ): Promise<void> {
    this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Starting for file ${editor.document.fileName}`);
    this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: includeLocalSecrets=${includeLocalSecrets}, isLocalSecretsEnabled=${this.isLocalSecretsEnabled}`);
    
    try {
      const relativeFilePath = getRelativeFilePath(editor);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Relative file path: ${relativeFilePath}`);
      
      if (!relativeFilePath) {
        this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: No relative file path, returning");
        return;
      }

      // Get the full git repository URL first
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      let repositoryUrl = repoData.serverUrl; // fallback
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Initial repository URL: ${repositoryUrl}`);
      
      if (workspaceFolder) {
        try {
          this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Getting remote URL for workspace: ${workspaceFolder.uri.fsPath}`);
          repositoryUrl = await getRemoteUrl(workspaceFolder.uri.fsPath);
          this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Retrieved remote URL: ${repositoryUrl}`);
        } catch (error) {
          // If we can't get the remote URL, use the fallback
          this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Failed to get remote URL, using fallback: ${error}`);
        }
      }

      // Fetch Apiiro risks and optionally local secrets
      const shouldScanLocalSecrets = includeLocalSecrets && this.isLocalSecretsEnabled;
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Should scan local secrets: ${shouldScanLocalSecrets}`);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Starting parallel fetch of Apiiro risks and local secrets");
      const promises: [Promise<Risk[]>, Promise<Risk[]>] = [
        findRisksForFile(relativeFilePath, repoData),
        shouldScanLocalSecrets
          ? this.onDemandSecretsService.scanFileForSecrets(
              relativeFilePath,
              editor.document.getText(),
              repositoryUrl
            )
          : Promise.resolve([])
      ];

      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Awaiting promises");
      const [apiiroRisks, localSecrets] = await Promise.all(promises);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Received ${apiiroRisks.length} Apiiro risks and ${localSecrets.length} local secrets`);

      // Log details about local secrets
      if (localSecrets.length > 0) {
        this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Local secrets details:");
        localSecrets.forEach((secret, index) => {
          this.outputChannel.appendLine(`  [${index}] Line ${secret.sourceCode.lineNumber}: ${secret.riskCategory} - ${secret.ruleName || secret.findingName || 'Unknown'}`);
        });
      }

      // Use enhanced diff service for merging and deduplication
      const allLineNumbers = [
        ...apiiroRisks.map(r => r.sourceCode.lineNumber),
        ...localSecrets.map(r => r.sourceCode.lineNumber)
      ];
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: All line numbers for diff service: ${allLineNumbers.join(', ')}`);

      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Calling enhanced diff service for line changes");
      const lineMapping = await this.enhancedDiffService.detectLineChangesWithLocalSupport(
        allLineNumbers,
        repoData,
        localSecrets
      );
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Line mapping received with ${Object.keys(lineMapping).length} entries`);

      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Merging risks with deduplication");
      const mergedRisks = await this.enhancedDiffService.mergeRisksWithDeduplication({
        apiiroRisks,
        localSecrets,
        lineMapping
      });
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Merged risks by ${mergedRisks.size} lines`);

      // Log merged risks details
      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Merged risks details:");
      for (const [lineNum, risks] of mergedRisks.entries()) {
        const localCount = risks.filter(isLocalSecretRisk).length;
        const apiiroCount = risks.filter(r => !isLocalSecretRisk(r)).length;
        this.outputChannel.appendLine(`  Line ${lineNum}: ${localCount} local, ${apiiroCount} Apiiro risks`);
      }

      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Applying enhanced inline highlights");
      await this.applyEnhancedInlineHighlights(editor, mergedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Updating remediation triggers");
      this.remediationTriggerProvider.updateRemediationTriggers(mergedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Updating diagnostics");
      this.diagnosticsHelper.updateDiagnostics(editor, mergedRisks);
      
      this.outputChannel.appendLine("[RiskHighlighter] highlightRisksForActiveFile: Completed successfully");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[RiskHighlighter] highlightRisksForActiveFile: Error occurred: ${error}`);
      vscode.window.showErrorMessage(
        `Error highlighting risks: ${errorMessage}`,
      );
    }
  }

  public removeAllHighlights(editor: vscode.TextEditor): void {
    this.outputChannel.appendLine(`[RiskHighlighter] removeAllHighlights: Removing all highlights for ${editor.document.fileName}`);
    
    this.decorationTypes.forEach((decoration) =>
      editor.setDecorations(decoration, []),
    );
    this.localDecorationTypes.forEach((decoration) =>
      editor.setDecorations(decoration, []),
    );
    this.diagnosticsHelper.clear();
    this.remediationTriggerProvider.updateRemediationTriggers(new Map());
    
    this.outputChannel.appendLine("[RiskHighlighter] removeAllHighlights: All highlights removed");
  }

  /**
   * Clear only Apiiro highlights, preserving local highlights
   */
  private clearApiiroHighlights(editor: vscode.TextEditor): void {
    this.outputChannel.appendLine(`[RiskHighlighter] clearApiiroHighlights: Clearing only Apiiro highlights for ${editor.document.fileName}`);
    
    this.decorationTypes.forEach((decoration) =>
      editor.setDecorations(decoration, []),
    );
    // Note: localDecorationTypes are NOT cleared here - this preserves local highlights
    
    this.outputChannel.appendLine("[RiskHighlighter] clearApiiroHighlights: Apiiro highlights cleared, local highlights preserved");
  }

  /**
   * Enhanced highlighting that handles both Apiiro risks and local secrets
   */
  private async applyEnhancedInlineHighlights(
    editor: vscode.TextEditor,
    groupedRisks: Map<number, Risk[]>,
  ): Promise<void> {
    this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Starting for ${groupedRisks.size} lines`);
    
    const apiiroDecorationsByLevel = new Map<string, vscode.DecorationOptions[]>();
    
    // Initialize decoration arrays (all risks use regular Apiiro colors now)
    this.decorationTypes.forEach((_, level) =>
      apiiroDecorationsByLevel.set(level, []),
    );
    this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Initialized decoration arrays for levels: ${Array.from(this.decorationTypes.keys()).join(', ')}`);

    for (const [lineNumber, risks] of groupedRisks.entries()) {
      this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Processing line ${lineNumber} with ${risks.length} risks`);
      
      try {
        // Separate local and Apiiro risks
        const localRisks = risks.filter(isLocalSecretRisk);
        const apiiroRisks = risks.filter(risk => !isLocalSecretRisk(risk));
        this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - ${localRisks.length} local, ${apiiroRisks.length} Apiiro risks`);

        // Priority system: If both types exist on same line, Apiiro risks take precedence for decoration
        // but hover message includes both types
        if (apiiroRisks.length > 0) {
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Processing Apiiro risks (priority)`);
          
          // Handle Apiiro risks (they get priority for decoration)
          const highestApiiroRiskLevel = DecorationHelper.getHighestRiskLevel(apiiroRisks);
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Highest Apiiro risk level: ${highestApiiroRiskLevel}`);
          
          const allRisksForHover = localRisks.length > 0 ? risks : apiiroRisks; // Include both if local exists
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Using ${allRisksForHover.length} risks for hover (including local: ${localRisks.length > 0})`);
          
          const apiiroDecoration = await this.createEnhancedDecoration(
            highestApiiroRiskLevel,
            editor,
            lineNumber,
            allRisksForHover, // Include all risks for comprehensive hover message
            false // isLocal = false
          );
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Created Apiiro decoration`);

          const apiiroDecorations = apiiroDecorationsByLevel.get(highestApiiroRiskLevel) || [];
          apiiroDecorations.push(apiiroDecoration);
          apiiroDecorationsByLevel.set(highestApiiroRiskLevel, apiiroDecorations);
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Added decoration to level ${highestApiiroRiskLevel} (total: ${apiiroDecorations.length})`);
          
        } else if (localRisks.length > 0) {
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Processing local secrets only`);
          
          // Handle local secrets only if no Apiiro risks on this line
          // Use regular Apiiro colors, not special local colors
          const highestLocalRiskLevel = DecorationHelper.getHighestRiskLevel(localRisks);
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Highest local risk level: ${highestLocalRiskLevel}`);
          
          const localDecoration = await this.createEnhancedDecoration(
            highestLocalRiskLevel,
            editor,
            lineNumber,
            localRisks, // Pass only local risks for hover message
            false // CHANGED: Use false to get regular Apiiro colors, not purple
          );
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Created local decoration (using Apiiro colors)`);

          const apiiroDecorations = apiiroDecorationsByLevel.get(highestLocalRiskLevel) || [];
          apiiroDecorations.push(localDecoration);
          apiiroDecorationsByLevel.set(highestLocalRiskLevel, apiiroDecorations);
          this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Line ${lineNumber} - Added local decoration to level ${highestLocalRiskLevel} (total: ${apiiroDecorations.length})`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Error creating decoration for line ${lineNumber}: ${error}`);
        vscode.window.showErrorMessage(
          `Error creating decoration for line ${lineNumber}: ${errorMessage}`,
        );
      }
    }

    // Clear only Apiiro highlights to preserve local secrets
    this.outputChannel.appendLine("[RiskHighlighter] applyEnhancedInlineHighlights: Clearing only Apiiro highlights to preserve local secrets");
    this.clearApiiroHighlights(editor);

    // Apply all decorations using regular Apiiro colors (local risks now use same colors)
    this.outputChannel.appendLine("[RiskHighlighter] applyEnhancedInlineHighlights: Applying decorations");
    apiiroDecorationsByLevel.forEach((decorations, level) => {
      const decorationType = this.decorationTypes.get(level);
      if (decorationType) {
        this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: Applying ${decorations.length} decorations for level ${level}`);
        editor.setDecorations(decorationType, decorations);
      } else {
        this.outputChannel.appendLine(`[RiskHighlighter] applyEnhancedInlineHighlights: No decoration type found for level ${level}`);
      }
    });

    this.outputChannel.appendLine("[RiskHighlighter] applyEnhancedInlineHighlights: Enhanced highlighting completed");
    // Note: localDecorationsByLevel no longer used - all risks use regular colors
  }

  /**
   * Original inline highlights method (removes all highlights first)
   */
  private async applyInlineHighlights(
    editor: vscode.TextEditor,
    groupedRisks: Map<number, Risk[]>,
  ): Promise<void> {
    const decorationsByLevel = new Map<string, vscode.DecorationOptions[]>();
    this.decorationTypes.forEach((_, level) =>
      decorationsByLevel.set(level, []),
    );

    for (const [lineNumber, risks] of groupedRisks.entries()) {
      try {
        const highestRiskLevel = DecorationHelper.getHighestRiskLevel(risks);

        const decoration = await this.createDecoration(
          highestRiskLevel,
          editor,
          lineNumber,
          risks,
        );

        const decorations = decorationsByLevel.get(highestRiskLevel) || [];
        decorations.push(decoration);
        decorationsByLevel.set(highestRiskLevel, decorations);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          `Error creating decoration for line ${lineNumber}: ${errorMessage}`,
        );
      }
    }

    // Use selective clearing instead of removeAllHighlights to preserve local highlights
    this.outputChannel.appendLine("[RiskHighlighter] applyInlineHighlights: Clearing only Apiiro highlights to preserve local ones");
    this.clearApiiroHighlights(editor);
    
    decorationsByLevel.forEach((decorations, level) => {
      const decorationType = this.decorationTypes.get(level);
      if (decorationType) {
        editor.setDecorations(decorationType, decorations);
      }
    });
  }

  private async createDecoration(
    highestRiskLevel: string,
    editor: vscode.TextEditor,
    lineNumber: number,
    risks: Risk[],
  ): Promise<vscode.DecorationOptions> {
    const range = editor.document.lineAt(lineNumber - 1).range;
    const uniqueRiskTypes = [...new Set(risks.map((r) => r.riskCategory))];

    return {
      range,
      hoverMessage: this.createHoverMessage(risks),
    };
  }

  /**
   * Enhanced decoration that can handle both local and Apiiro risks
   */
  private async createEnhancedDecoration(
    highestRiskLevel: string,
    editor: vscode.TextEditor,
    lineNumber: number,
    risks: Risk[],
    isLocal: boolean,
  ): Promise<vscode.DecorationOptions> {
    const range = editor.document.lineAt(lineNumber - 1).range;

    return {
      range,
      hoverMessage: this.createEnhancedHoverMessage(risks, isLocal),
    };
  }

  private createHoverMessage(risks: Risk[]): vscode.MarkdownString {
    const message = risks
      .map((risk) => {
        switch (risk.riskCategory) {
          case "OSS Security":
            return createOSSMessage(risk as OSSRisk);
          case "Secrets":
            return createSecretsMessage(risk as SecretsRisk);
          case "SAST Findings":
            return createSastHoverMessage(risk as SASTRisk);
          case "Sensitive Data":
          case "Entry Point Changes":
            return createApiHoverMessage(risk);
          default:
            return createDefaultMessage(risk);
        }
      })
      .join("\n\n---\n\n");

    const markdownMessage = new vscode.MarkdownString(message);
    markdownMessage.isTrusted = true;
    markdownMessage.supportHtml = true;
    return markdownMessage;
  }

  /**
   * Enhanced hover message that handles both local and Apiiro risks
   */
  private createEnhancedHoverMessage(risks: Risk[], isLocal: boolean): vscode.MarkdownString {
    // Separate local and Apiiro risks
    const localRisks = risks.filter(isLocalSecretRisk);
    const apiiroRisks = risks.filter(risk => !isLocalSecretRisk(risk));

    const messages: string[] = [];

    // Add local secret messages first (they're more urgent)
    if (localRisks.length > 0) {
      const localMessages = localRisks.map(localRisk => 
        createLocalSecretsMessage(localRisk as SecretsRisk)
      );
      messages.push(...localMessages);
    }

    // Add Apiiro risk messages
    if (apiiroRisks.length > 0) {
      const apiiroMessages = apiiroRisks.map((risk) => {
        switch (risk.riskCategory) {
          case "OSS Security":
            return createOSSMessage(risk as OSSRisk);
          case "Secrets":
            return createSecretsMessage(risk as SecretsRisk);
          case "SAST Findings":
            return createSastHoverMessage(risk as SASTRisk);
          case "Sensitive Data":
          case "Entry Point Changes":
            return createApiHoverMessage(risk);
          default:
            return createDefaultMessage(risk);
        }
      });
      messages.push(...apiiroMessages);
    }

    // Join all messages
    const combinedMessage = messages.join("\n\n---\n\n");

    const markdownMessage = new vscode.MarkdownString(combinedMessage);
    markdownMessage.isTrusted = true;
    markdownMessage.supportHtml = true;
    return markdownMessage;
  }
}
