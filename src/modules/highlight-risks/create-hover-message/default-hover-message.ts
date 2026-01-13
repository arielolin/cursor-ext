import { Risk } from "../../../types/risk";
import { getSeverityIcon } from "../utils";
import { hasRemedy } from "../../remediate-risks/remediate-risks";
import { getEnvironmentData } from "../../../services/apiiro-rest-api-provider";

export function createDefaultMessage(risk: Risk): string {
  const severityIcon = getSeverityIcon(risk.riskLevel);
  const encodedRisk = encodeURIComponent(JSON.stringify(risk));

  return `### ${severityIcon} ${risk.riskLevel} severity: ${risk.findingName || risk.ruleName}
    
${hasRemedy(risk) ? `\n[Remediate](command:apiiro-code.remediate?${encodedRisk})` : ""}

**Risk Category:** ${risk.riskCategory}

**Discovered on:** ${new Date(risk.discoveredOn)?.toLocaleString()}

**Description:** ${risk.ruleName}

**Apiiro Link:** [View in Apiiro](${getEnvironmentData().AppUrl}/risks?fl&trigger=${risk.id})

${hasRemedy(risk) ? `\n[Remediate](command:apiiro-code.remediate?${encodedRisk})` : ""}

[✧ Fix with AutoFix AI Agent](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(risk))})
`;
}
