import { OSSRisk } from "../../../types/risk";
import { hasRemedy } from "../../remediate-risks/remediate-risks";
import { getSeverityIcon } from "../utils";
import { getEnvironmentData } from "../../../services/apiiro-rest-api-provider";

class OSSMessageBuilder {
  private message: string[] = [];
  private risk: OSSRisk;

  constructor(risk: OSSRisk) {
    this.risk = risk;
  }

  addHeader(): OSSMessageBuilder {
    const severityEmoji = getSeverityIcon(this.risk.riskLevel);
    this.message.push(
      `### ${severityEmoji} ${this.risk.riskLevel} severity risk: ${this.risk.findingName || this.risk.ruleName}`,
    );
    return this;
  }

  addRemediateLink(): OSSMessageBuilder {
    if (hasRemedy(this.risk)) {
      const encodedRisk = encodeURIComponent(JSON.stringify(this.risk));
      this.message.push(
        `🔧 [Remediate](command:apiiro-code.remediate?${encodedRisk})`,
      );
    }
    return this;
  }

  addDependencyInfo(): OSSMessageBuilder {
    if (this.risk.dependencyName) {
      this.message.push(`📦 **Dependency:** ${this.risk.dependencyName}`);
    }
    if (this.risk.type) {
      this.message.push(`🔗 **Type:** ${this.risk.type}`);
    }
    return this;
  }

  addDiscoveryDate(): OSSMessageBuilder {
    if (this.risk.discoveredOn) {
      this.message.push(
        `**Discovered on:** ${new Date(this.risk.discoveredOn).toLocaleString()}`,
      );
    }
    return this;
  }

  private getCVSSEmoji(cvss: number): string {
    if (cvss >= 9.0) return "🔴";
    if (cvss >= 7.0) return "🟠";
    if (cvss >= 4.0) return "🟡";
    return "🟢";
  }

  private getEPSSEmoji(epss: number): string {
    if (epss >= 0.5) return "🔴";
    if (epss >= 0.1) return "🟠";
    if (epss >= 0.01) return "🟡";
    return "🟢";
  }

  addVulnerabilities(): OSSMessageBuilder {
    if (this.risk.vulnerabilities?.length) {
      const vulnInfo = this.risk.vulnerabilities
        .map(
          (v, index) => `
🔍 Vulnerability ${index + 1}
**ID:** ${v.identifiers.join(", ")}
**Issue:** ${v.id}
**CVSS:** ${this.getCVSSEmoji(v.cvss)} ${v.cvss}
**Exploit Maturity:** ${v.exploitMaturity || "N/A"}
**EPSS:** ${v.epss ? `${this.getEPSSEmoji(v.epss.score)} ${v.epss.score} (${v.epss.scoreSeverity})` : "N/A"}
**CWE:** ${v.identifiers.find((id) => id.startsWith("CWE")) || "N/A"}
**Fix Version:** ${this.risk.remediationSuggestion?.nearestFixVersion || "N/A"}`,
        )
        .join("\n");

      this.message.push(vulnInfo);
    }
    return this;
  }

  addRemediationSuggestions(): OSSMessageBuilder {
    if (this.risk.remediationSuggestion) {
      const suggestions = `### 💡 Remediation Suggestions

1. Update the ${this.risk.dependencyName.split(":")[0]} package to version ${this.risk.remediationSuggestion.nearestFixVersion} or later.
2. Location: ${this.risk.remediationSuggestion.codeReference.filePath}
3. Regularly scan and update all dependencies to minimize exposure to known vulnerabilities.`;

      this.message.push(suggestions);
    }
    return this;
  }

  addApiiroLink(): OSSMessageBuilder {
    const appUrl = getEnvironmentData().AppUrl;
    if (appUrl && this.risk.id) {
      this.message.push(
        `**Apiiro Link:** [View in Apiiro](${appUrl}/risks?fl&trigger=${this.risk.id})`,
      );
    }
    return this;
  }

  addCursorChatLink(): OSSMessageBuilder {
    if (this.risk.id) {
      this.message.push(
        `[✧ Fix with AutoFix AI Agent](command:apiiro-code.openCursorChat?${encodeURIComponent(JSON.stringify(this.risk))})`,
      );
    }
    return this;
  }

  build(): string {
    return this.message.join("\n\n");
  }
}

export function createOSSMessage(risk: OSSRisk): string {
  return new OSSMessageBuilder(risk)
    .addHeader()
    .addApiiroLink()
    .addRemediateLink()
    .addDependencyInfo()
    .addDiscoveryDate()
    .addVulnerabilities()
    .addRemediationSuggestions()
    .addRemediateLink()
    .addCursorChatLink()
    .build();
}
