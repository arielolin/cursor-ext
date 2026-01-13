import { SecretsRisk } from "../../../types/risk";
import { getSeverityIcon } from "../utils";

export function createLocalSecretsMessage(risk: SecretsRisk): string {
  const severityIcon = getSeverityIcon(risk.riskLevel);

  return `### ${severityIcon}  ${risk.riskLevel} severity risk: ${risk.findingName || risk.ruleName} (Local Scan)
  
**🔍 Local Scan:** This secret was detected in your current workspace

**Secret type:**  ${risk.secretType ?? "N/A"}

**Discovered on:** ${new Date().toLocaleString()} (Local detection)

**Validity:** ${risk.validity}${risk.lastValidatedOn ? `. Last checked as invalid: ${new Date(risk.lastValidatedOn).toLocaleString()}` : ""}

**Exposure:** ${risk.exposure ?? "N/A"}

[✧ Fix with AutoFix AI Agent](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(risk))})
`;
}

export function createLocalSecretsCondensedMessage(risk: SecretsRisk): string {
  const severityIcon = getSeverityIcon(risk.riskLevel);

  return `${severityIcon} **Local Secret (${risk.riskLevel}):** ${risk.secretType} - Remove before committing`;
}