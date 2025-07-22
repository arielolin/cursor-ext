import * as vscode from "vscode";
import { Risk } from "../../types/risk";
import { Repository } from "../../types/repository";
import { DependencyRemediationFactory } from "./remediate-oss-factory";
import { OutputChannel } from "vscode";

const supportedFileTypesForRemediation = [
  "package.json",
  "requirements.txt",
  /* "pom.xml",
  "yarn.lock",
  "Gemfile.lock",
  "build.sbt",
  "build.gradle",
  "build.gradle.kts",
  "package-lock.json",*/
];

export interface RiskRemediation {
  remediate(
    editor: vscode.TextEditor,
    risk: Risk,
    repoData: Repository | undefined,
  ): Promise<void>;
}

class OSSRiskRemediation implements RiskRemediation {
  private onRiskRemediation: () => void;

  constructor(onRiskRemediation: () => void) {
    this.onRiskRemediation = onRiskRemediation;
  }

  async remediate(
    editor: vscode.TextEditor,
    risk: Risk,
    repoData: Repository | undefined,
  ): Promise<void> {
    throw new Error("No specific remediator found for this file type");
  }
}

export class RiskRemediationFactory {
  static createRemediation(
    riskCategory: string,
    onRiskRemediation: () => void,
    filename?: string,
  ): RiskRemediation {
    switch (riskCategory) {
      case "OSS Security": {
        if (filename) {
          const dependencyFactory = new DependencyRemediationFactory(
            onRiskRemediation,
          );
          const specificRemediator = dependencyFactory.getRemediator(filename);
          if (specificRemediator) {
            return specificRemediator;
          }
        }
        return new OSSRiskRemediation(onRiskRemediation);
      }
      default:
        throw new Error(`Unsupported risk category: ${riskCategory}`);
    }
  }
}

export async function remediateRisk(
  editor: vscode.TextEditor,
  risk: Risk,
  repoData: Repository | undefined,
  onRiskRemediation: () => void,
): Promise<void> {
  try {
    const remediation = RiskRemediationFactory.createRemediation(
      risk.riskCategory,
      onRiskRemediation,
      editor.document.fileName, // Pass the filename to get specific handler
    );
    await remediation.remediate(editor, risk, repoData);
  } catch (error: any) {
    console.error("Error remediating risk:", error);
    vscode.window.showErrorMessage(`Error remediating risk: ${error.message}`);
  }
}

export function hasRemedy(risk: Risk, logger?: OutputChannel): boolean {
  const fileName =
    vscode.Uri.parse(risk.sourceCode.filePath).path.split("/").pop() || "";

  logger?.appendLine(`Checking remediation for ${fileName}`);
  logger?.appendLine(`remediation suggestion: ${JSON.stringify(risk)}`);

  return (
    !!risk.remediationSuggestion &&
    supportedFileTypesForRemediation.includes(fileName.toLowerCase())
  );
}
