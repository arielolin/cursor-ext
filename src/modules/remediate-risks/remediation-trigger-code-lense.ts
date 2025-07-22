import vscode from "vscode";
import { Risk } from "../../types/risk";
import { hasRemedy } from "./remediate-risks";

export class RiskRemediationTriggerCodeLensProvider
  implements vscode.CodeLensProvider
{
  private groupedRisks: Map<number, Risk[]> = new Map();
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private logger = vscode.window.createOutputChannel("Risk Remediation");

  public updateRemediationTriggers(risks: Map<number, Risk[]>) {
    this.groupedRisks = risks;
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    for (const [lineNumber, risks] of this.groupedRisks.entries()) {
      const remediableRisk = risks.find((risk) => hasRemedy(risk, this.logger));

      if (remediableRisk) {
        const range = new vscode.Range(
          new vscode.Position(lineNumber - 1, 0),
          new vscode.Position(lineNumber - 1, 0),
        );

        codeLenses.push(
          new vscode.CodeLens(range, {
            title: "🔧 Remediate",
            command: "apiiro-code.remediate",
            arguments: [remediableRisk],
          }),
        );
      }
    }

    return codeLenses;
  }
}
