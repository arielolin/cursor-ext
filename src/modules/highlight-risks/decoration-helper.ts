// src/features/risk-highlighter/decoration-helper.ts
import * as vscode from "vscode";
import { Risk, RiskLevel, riskLevels } from "../../types/risk";

interface RiskDecoration {
  backgroundColor: string;
  overviewRulerColor: string;
}

export class DecorationHelper {
  private static readonly RISK_COLORS = {
    [riskLevels.Critical]: {
      backgroundColor: "rgba(255, 0, 0, 0.4)",
      overviewRulerColor: "#FF0000",
    },
    [riskLevels.High]: {
      backgroundColor: "rgba(255, 69, 0, 0.3)",
      overviewRulerColor: "#ff4d00",
    },
    [riskLevels.Medium]: {
      backgroundColor: "rgba(255, 165, 0, 0.3)",
      overviewRulerColor: "#FFA500",
    },
    [riskLevels.Low]: {
      backgroundColor: "rgba(255, 255, 0, 0.2)",
      overviewRulerColor: "#FFFF00",
    },
  };

  static createDecoration(
    riskLevel: RiskLevel,
  ): vscode.TextEditorDecorationType {
    const decoration = (this.RISK_COLORS[riskLevel] ||
      this.RISK_COLORS.Low) as unknown as RiskDecoration;

    return vscode.window.createTextEditorDecorationType({
      backgroundColor: decoration.backgroundColor,
      overviewRulerColor: decoration.overviewRulerColor,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  static getHighestRiskLevel(risks: Risk[]): string {
    return risks.reduce((highest: RiskLevel, risk) => {
      const currentIndex = Object.values(riskLevels).indexOf(risk.riskLevel);
      const highestIndex = Object.values(riskLevels).indexOf(highest);
      return currentIndex < highestIndex ? risk.riskLevel : highest;
    }, riskLevels.Low);
  }
}
