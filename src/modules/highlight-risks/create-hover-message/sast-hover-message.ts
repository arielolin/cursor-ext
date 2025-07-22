import {
  Risk,
  RiskLevel,
  SecretsRisk,
  SASTRisk,
  isSASTRisk,
} from "../../../types/risk";
import { getSeverityIcon } from "../utils";
import { hasRemedy } from "../../remediate-risks/remediate-risks";
import { getEnvironmentData } from "../../../services/apiiro-rest-api-provider";
import vscode from "vscode";

function formatComplianceLinks(risk: SASTRisk): string {
  const cweLinks = risk.complianceFrameworkReferences
    .filter((ref) => ref.securityComplianceFramework === "Cwe")
    .map((cwe) => `[CWE-${cwe.identifier}: ${cwe.description}](${cwe.url})`)
    .join("\n");

  const owaspLinks = risk.complianceFrameworkReferences
    .filter((ref) => ref.securityComplianceFramework === "Owasp")
    .map(
      (owasp) =>
        `[OWASP-${owasp.identifier}: ${owasp.description}](${owasp.url})`,
    )
    .join("\n");

  return `${cweLinks ? `\n**CWE References:**\n${cweLinks}` : ""}${owaspLinks ? `\n**OWASP References:**\n${owaspLinks}` : ""}`;
}

export function createSastHoverMessage(risk: SASTRisk): string {
  const severityIcon = getSeverityIcon(risk.riskLevel);

  return `### ${severityIcon} ${risk.riskLevel} SAST Finding Risk

**Source:** ${risk.source[0].name}${risk.source[0].url ? ` ([link](${risk.source[0].url}))` : ""}

**Description:** ${risk.findingName} (${risk.type})

**Severity:** ${risk.riskLevel}

**Apiiro Link:** [View in Apiiro](${getEnvironmentData().AppUrl}/risks?fl&trigger=${risk.id})

**Finding Type:** ${risk.findingType}

**Risk Category:** ${risk.riskCategory}

**Discovered on:** ${new Date(risk.discoveredOn)?.toLocaleString()}

${formatComplianceLinks(risk)}

[💬 Open in Cursor Chat](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(risk))})

**More info:** ${risk.description}
`;
}
