import { Risk, RiskLevel, riskLevels } from "../../types/risk";

export function getSeverityIcon(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case riskLevels.Critical:
      return "🚨";
    case riskLevels.High:
      return "❗";
    case riskLevels.Medium:
      return "☢️";
    case riskLevels.Low:
      return "⚠️";
    default:
      return "❓";
  }
}
