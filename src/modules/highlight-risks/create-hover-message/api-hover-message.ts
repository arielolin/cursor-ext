import { APIRisk } from "../../../types/risk";
import { getSeverityIcon } from "../utils";
import { getEnvironmentData } from "../../../services/apiiro-rest-api-provider";

export interface APIRiskDetails {
  method: string;
  path: string;
  module: string;
  authorization?: string;
  apiDeclaration?: string;
  responseFormat?: string;
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
  authentication?: {
    type: string;
    details: string;
  };
  documentation?: string;
  sensitivityScore?: number;
  sensitivityReasons?: string[];
}

export function parseAPIRiskDetails(risk: APIRisk): {
  authorization: string | undefined;
  path: string;
  sensitivityScore: number | undefined;
  method: string;
  module: string;
  documentation: string | undefined;
  businessImpact: string;
  apiDeclaration: string | undefined;
  responseFormat: string | undefined;
  parameters:
    | Array<{
        name: string;
        type: string;
        required: boolean;
        description?: string;
      }>
    | undefined;
  sensitivityReasons: string[] | undefined;
  authentication: { type: string; details: string } | undefined;
} {
  // Extract method and path from component
  const [method, ...pathParts] = risk.component.split(" ");
  const path = pathParts.join(" ");

  return {
    method,
    path,
    module: risk.entity.details.name,
    businessImpact: risk.entity.details.businessImpact,
    authorization: risk.authorization?.details,
    apiDeclaration: risk.apiType,
    responseFormat: risk.apiDetails?.responseFormat,
    parameters: risk.apiDetails?.parameters,
    authentication: risk.authentication,
    documentation: risk.apiDetails?.documentation,
    sensitivityScore: risk.sensitivityPrediction?.score,
    sensitivityReasons: risk.sensitivityPrediction?.reasons,
  };
}

export function createApiHoverMessage(risk: APIRisk): string {
  const severityIcon = getSeverityIcon(risk.riskLevel);
  const details = parseAPIRiskDetails(risk);

  return `### ${severityIcon}API ${risk.riskLevel} severity risk: ${risk.ruleName}
  
**Apiiro Link:** [View in Apiiro](${getEnvironmentData().AppUrl}/risks?fl&trigger=${risk.id})

**Module:** ${details.module} (${details.businessImpact} business impact) 

**HTTP Method:** ${details.method}

**Authorization:** ${details.authorization || "Not specified"}

**API Declaration:** ${details.apiDeclaration || "Not specified"}

${details.authentication ? `**Authentication:**\n- Type: ${details.authentication.type}\n- Details: ${details.authentication.details}\n` : ""}

${
  details.parameters
    ? `**Parameters:**\n${details.parameters
        .map(
          (p) =>
            `- ${p.name} (${p.type})${p.required ? " [Required]" : ""}: ${p.description || "No description"}`,
        )
        .join("\n")}\n`
    : ""
}

${details.responseFormat ? `**Response Format:** ${details.responseFormat}\n` : ""}

${details.sensitivityScore ? `**Sensitivity Score:** ${details.sensitivityScore}\n` : ""}

${details.sensitivityReasons ? `**Sensitivity Reasons:**\n${details.sensitivityReasons.map((r) => `- ${r}`).join("\n")}\n` : ""}

**Insights:**
${risk.insights.map((insight) => `- ${insight.name}: ${insight.reason}`).join("\n")}

**Discovery Date:** ${new Date(risk.discoveredOn)?.toLocaleString()}

[✧ Fix with AutoFix AI Agent](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(risk))})

`;
}
