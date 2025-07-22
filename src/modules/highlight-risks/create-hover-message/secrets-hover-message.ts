import { RiskLevel, SecretsRisk } from "../../../types/risk";
import { getSeverityIcon } from "../utils";
import { hasRemedy } from "../../remediate-risks/remediate-risks";
import { getEnvironmentData } from "../../../services/apiiro-rest-api-provider";

export function createSecretsMessage(risk: SecretsRisk): string {
  const encodedRisk = encodeURIComponent(JSON.stringify(risk));
  const severityIcon = getSeverityIcon(risk.riskLevel);

  return `### ${severityIcon}  ${risk.riskLevel} severity risk: ${risk.findingName || risk.ruleName}
  
**Apiiro Link:** [View in Apiiro](${getEnvironmentData().AppUrl}/risks?fl&trigger=${risk.id})

**Secret type:**  ${risk.secretType ?? "N/A"}

**Discovered on:** ${new Date(risk.discoveredOn).toLocaleString() ?? "N/A"}

**Validity:** ${risk.validity}${risk.lastValidatedOn ? `. Last checked as invalid: ${new Date(risk.lastValidatedOn).toLocaleString()}` : ""}

**Exposure:** ${risk.exposure ?? "N/A"}

${hasRemedy(risk) ? `\n[Remediate](command:apiiro-code.remediate?${encodedRisk})` : ""}

[💬 Open in Cursor Chat](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(risk))})
`;
}
