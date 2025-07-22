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
import { detectLineChanges } from "../../services/diff-service";
import { findRisksForFile } from "../../services/file-risk-service";

export class RiskHighlighter {
  private readonly decorationTypes: Map<
    string,
    vscode.TextEditorDecorationType
  >;
  private readonly diagnosticsHelper: DiagnosticsHelper;
  private readonly remediationTriggerProvider: RiskRemediationTriggerCodeLensProvider;

  constructor(context: vscode.ExtensionContext) {
    this.decorationTypes = new Map([
      [
        riskLevels.Critical,
        DecorationHelper.createDecoration(riskLevels.Critical),
      ],
      [riskLevels.High, DecorationHelper.createDecoration(riskLevels.High)],
      [riskLevels.Medium, DecorationHelper.createDecoration(riskLevels.Medium)],
      [riskLevels.Low, DecorationHelper.createDecoration(riskLevels.Low)],
    ]);

    this.diagnosticsHelper = new DiagnosticsHelper();
    this.remediationTriggerProvider =
      new RiskRemediationTriggerCodeLensProvider();

    context.subscriptions.push(
      ...Array.from(this.decorationTypes.values()),
      this.diagnosticsHelper,
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        this.remediationTriggerProvider,
      ),
    );
  }

  public async highlightRisksForActiveFile(
    editor: vscode.TextEditor,
    repoData: Repository,
  ): Promise<void> {
    try {
      const relativeFilePath = getRelativeFilePath(editor);
      if (!relativeFilePath) {
        return;
      }

      const risks = await findRisksForFile(relativeFilePath, repoData);
      const riskyLines = await this.validateAndGroupRisksByLine(
        risks,
        repoData,
      );

      await this.applyInlineHighlights(editor, riskyLines);
      this.remediationTriggerProvider.updateRemediationTriggers(riskyLines);
      this.diagnosticsHelper.updateDiagnostics(editor, riskyLines);
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
    this.diagnosticsHelper.clear();
    this.remediationTriggerProvider.updateRemediationTriggers(new Map());
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
