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
import { 
  LocalSecretRisk, 
  isLocalSecretRisk,
  LocalLineChangeInfo 
} from "../../types/local-secret-risk";
import { getRemoteUrl } from "../../services/git-service";

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

  constructor(context: vscode.ExtensionContext) {
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
    this.onDemandSecretsService = new OnDemandSecretsService();
    this.enhancedDiffService = new EnhancedDiffService();
    
    // Check if local secrets scanning is enabled
    this.isLocalSecretsEnabled = this.getLocalSecretsConfig();

    context.subscriptions.push(
      ...Array.from(this.decorationTypes.values()),
      ...Array.from(this.localDecorationTypes.values()),
      this.diagnosticsHelper,
      this.onDemandSecretsService,
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        this.remediationTriggerProvider,
      ),
      // Listen for configuration changes
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("apiiroCode.secretsOnDemand")) {
          this.isLocalSecretsEnabled = this.getLocalSecretsConfig();
        }
      })
    );
  }

  /**
   * Get local secrets configuration from VS Code settings
   */
  private getLocalSecretsConfig(): boolean {
    const config = vscode.workspace.getConfiguration("apiiroCode.secretsOnDemand");
    return config.get("enabled", true);
  }

  /**
   * Lightweight highlighting for text changes - only Apiiro risks, no local secrets
   */
  public async highlightApiiroRisksOnly(
    editor: vscode.TextEditor,
    repoData: Repository,
  ): Promise<void> {
    try {
      const relativeFilePath = getRelativeFilePath(editor);
      if (!relativeFilePath) {
        return;
      }

      // Only fetch Apiiro risks for fast highlighting during text changes
      const apiiroRisks = await findRisksForFile(relativeFilePath, repoData);

      if (apiiroRisks.length === 0) {
        await this.removeAllHighlights(editor);
        return;
      }

      // Use simple line change detection (not enhanced)
      const lineNumbers = apiiroRisks.map(r => r.sourceCode.lineNumber);
      const lineChanges = await detectLineChanges(lineNumbers, repoData);
      
      const groupedRisks = new Map<number, Risk[]>();
      
      for (const risk of apiiroRisks) {
        const lineNum = risk.sourceCode.lineNumber;
        const lineChange = lineChanges.find(change => change.originalLineNumber === lineNum);
        
        // Skip risks on changed lines
        if (lineChange?.hasChanged) {
          continue;
        }
        
        const effectiveLineNumber = lineChange?.newLineNum ?? lineNum;
        
        if (!groupedRisks.has(effectiveLineNumber)) {
          groupedRisks.set(effectiveLineNumber, []);
        }
        
        groupedRisks.get(effectiveLineNumber)!.push(risk);
      }

      await this.applyInlineHighlights(editor, groupedRisks);
      this.remediationTriggerProvider.updateRemediationTriggers(groupedRisks);
      this.diagnosticsHelper.updateDiagnostics(editor, groupedRisks);
      
    } catch (error) {
      console.error("Error highlighting Apiiro risks:", error);
    }
  }

  public async highlightRisksForActiveFile(
    editor: vscode.TextEditor,
    repoData: Repository,
    includeLocalSecrets: boolean = true
  ): Promise<void> {
    try {
      const relativeFilePath = getRelativeFilePath(editor);
      if (!relativeFilePath) {
        return;
      }

      // Get the full git repository URL first
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      let repositoryUrl = repoData.serverUrl; // fallback
      
      if (workspaceFolder) {
        try {
          repositoryUrl = await getRemoteUrl(workspaceFolder.uri.fsPath);
        } catch (error) {
          // If we can't get the remote URL, use the fallback
          console.warn("Failed to get remote URL, using fallback:", error);
        }
      }

      // Fetch Apiiro risks and optionally local secrets
      const promises: [Promise<Risk[]>, Promise<LocalSecretRisk[]>] = [
        findRisksForFile(relativeFilePath, repoData),
        (includeLocalSecrets && this.isLocalSecretsEnabled)
          ? this.onDemandSecretsService.scanFileForSecrets(
              relativeFilePath,
              editor.document.getText(),
              repositoryUrl
            )
          : Promise.resolve([])
      ];

      const [apiiroRisks, localSecrets] = await Promise.all(promises);

      // Use enhanced diff service for merging and deduplication
      const allLineNumbers = [
        ...apiiroRisks.map(r => r.sourceCode.lineNumber),
        ...localSecrets.map(r => r.sourceCode.lineNumber)
      ];

      const lineMapping = await this.enhancedDiffService.detectLineChangesWithLocalSupport(
        allLineNumbers,
        repoData,
        localSecrets
      );

      const mergedRisks = await this.enhancedDiffService.mergeRisksWithDeduplication({
        apiiroRisks,
        localSecrets,
        lineMapping
      });

      await this.applyEnhancedInlineHighlights(editor, mergedRisks);
      this.remediationTriggerProvider.updateRemediationTriggers(mergedRisks);
      this.diagnosticsHelper.updateDiagnostics(editor, mergedRisks);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Error highlighting risks: ${errorMessage}`,
      );
    }
  }

  public removeAllHighlights(editor: vscode.TextEditor): void {
    this.decorationTypes.forEach((decoration) =>
      editor.setDecorations(decoration, []),
    );
    this.localDecorationTypes.forEach((decoration) =>
      editor.setDecorations(decoration, []),
    );
    this.diagnosticsHelper.clear();
    this.remediationTriggerProvider.updateRemediationTriggers(new Map());
  }

  /**
   * Enhanced highlighting that handles both Apiiro risks and local secrets
   */
  private async applyEnhancedInlineHighlights(
    editor: vscode.TextEditor,
    groupedRisks: Map<number, Risk[]>,
  ): Promise<void> {
    const apiiroDecorationsByLevel = new Map<string, vscode.DecorationOptions[]>();
    const localDecorationsByLevel = new Map<string, vscode.DecorationOptions[]>();
    
    // Initialize decoration arrays
    this.decorationTypes.forEach((_, level) =>
      apiiroDecorationsByLevel.set(level, []),
    );
    this.localDecorationTypes.forEach((_, level) =>
      localDecorationsByLevel.set(level, []),
    );

    for (const [lineNumber, risks] of groupedRisks.entries()) {
      try {
        // Separate local and Apiiro risks
        const localRisks = risks.filter(isLocalSecretRisk);
        const apiiroRisks = risks.filter(risk => !isLocalSecretRisk(risk));

        // Handle Apiiro risks
        if (apiiroRisks.length > 0) {
          const highestApiiroRiskLevel = DecorationHelper.getHighestRiskLevel(apiiroRisks);
          const apiiroDecoration = await this.createEnhancedDecoration(
            highestApiiroRiskLevel,
            editor,
            lineNumber,
            risks, // Include all risks for hover message
            false // isLocal = false
          );

          const apiiroDecorations = apiiroDecorationsByLevel.get(highestApiiroRiskLevel) || [];
          apiiroDecorations.push(apiiroDecoration);
          apiiroDecorationsByLevel.set(highestApiiroRiskLevel, apiiroDecorations);
        }

        // Handle local secrets
        if (localRisks.length > 0) {
          const highestLocalRiskLevel = DecorationHelper.getHighestRiskLevel(localRisks);
          const localDecoration = await this.createEnhancedDecoration(
            highestLocalRiskLevel,
            editor,
            lineNumber,
            risks, // Include all risks for hover message
            true // isLocal = true
          );

          const localDecorations = localDecorationsByLevel.get(highestLocalRiskLevel) || [];
          localDecorations.push(localDecoration);
          localDecorationsByLevel.set(highestLocalRiskLevel, localDecorations);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          `Error creating decoration for line ${lineNumber}: ${errorMessage}`,
        );
      }
    }

    // Clear all existing highlights
    this.removeAllHighlights(editor);

    // Apply Apiiro risk decorations
    apiiroDecorationsByLevel.forEach((decorations, level) => {
      const decorationType = this.decorationTypes.get(level);
      if (decorationType) {
        editor.setDecorations(decorationType, decorations);
      }
    });

    // Apply local secret decorations
    localDecorationsByLevel.forEach((decorations, level) => {
      const decorationType = this.localDecorationTypes.get(level);
      if (decorationType) {
        editor.setDecorations(decorationType, decorations);
      }
    });
  }

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

    this.removeAllHighlights(editor);
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
        createLocalSecretsMessage(localRisk)
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

  private async validateAndGroupRisksByLine(
    risks: Risk[],
    repoData: Repository,
  ): Promise<Map<number, Risk[]>> {
    const groupedRisks = new Map<number, Risk[]>();

    try {
      const lineNumbers = risks.map((risk) => risk.sourceCode.lineNumber);
      const lineChangesData = await detectLineChanges(lineNumbers, repoData);

      if (lineChangesData[0]?.errors?.length) {
        throw new Error(lineChangesData[0].errors.join(","));
      }

      risks.forEach((risk, index) => {
        const { hasChanged, newLineNum } = lineChangesData[index];
        const lineNumber = hasChanged
          ? -1
          : newLineNum || risk.sourceCode.lineNumber;

        if (hasChanged) {
          groupedRisks.delete(lineNumber);
          return;
        }

        if (!groupedRisks.has(lineNumber)) {
          groupedRisks.set(lineNumber, []);
        }
        groupedRisks.get(lineNumber)!.push(risk);
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Error highlighting risks: ${errorMessage}`,
      );
      return new Map();
    }

    return groupedRisks;
  }
}
