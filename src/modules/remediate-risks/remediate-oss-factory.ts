// remediate-oss-factory.ts
import * as vscode from "vscode";
import * as path from "path";
import { Risk } from "../../types/risk";
import { RiskRemediation } from "./remediate-risks";
import { addSuggestionLine } from "./suggestion-helper";
import { Repository } from "../../types/repository";
import { detectLineChanges } from "../../services/diff-service";

interface DependencyRemediation extends RiskRemediation {
  canHandle(filename: string): boolean;
}

export class DependencyRemediationFactory {
  private remediators: DependencyRemediation[] = [];

  constructor(onRiskRemediation: () => void) {
    this.remediators = [
      new PackageJsonRemediation(onRiskRemediation),
      new RequirementsTxtRemediation(onRiskRemediation),
      new PomXmlRemediation(onRiskRemediation),
    ];
  }

  getRemediator(filename: string): DependencyRemediation | undefined {
    const normalizedFilename = path.basename(filename).toLowerCase();
    return this.remediators.find((r) => r.canHandle(normalizedFilename));
  }
}

abstract class BaseRemediation implements DependencyRemediation {
  protected onRiskRemediation: () => void;

  constructor(onRiskRemediation: () => void) {
    this.onRiskRemediation = onRiskRemediation;
  }

  abstract canHandle(filename: string): boolean;

  protected abstract validateDependency(
    originalText: string,
    depKey: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<boolean>;

  protected abstract createUpdatedLineText(
    originalText: string,
    depKey: string,
    fixVersion: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<string>;

  async remediate(
    editor: vscode.TextEditor,
    risk: Risk,
    repoData: Repository,
  ): Promise<void> {
    try {
      if (!editor) {
        throw new Error("No active text editor");
      }

      const document = editor.document;
      const depKey = risk.component;

      let fixVersion = risk.remediationSuggestion?.nearestFixVersion;

      if (!fixVersion) {
        vscode.window.showErrorMessage(
          "No fix version found for the specified dependency",
        );
        return;
      }
      const lineChangesData = await detectLineChanges(
        [risk.sourceCode.lineNumber],
        repoData,
      );
      const lineNumber = lineChangesData[0].hasMoved
        ? lineChangesData[0].newLineNum
        : risk.sourceCode.lineNumber;

      const line = document.lineAt(lineNumber! - 1);
      const originalText = line.text;

      const isValid = await this.validateDependency(
        originalText,
        depKey,
        document,
        lineNumber! - 1,
      );

      if (!isValid) {
        vscode.window.showErrorMessage(
          `${depKey} was not found in the specified location or is in an invalid format`,
        );
        return;
      }

      const updatedLineText = await this.createUpdatedLineText(
        originalText,
        depKey,
        fixVersion,
        document,
        lineNumber! - 1,
      );

      await addSuggestionLine(
        editor,
        lineNumber!,
        originalText,
        updatedLineText,
        this.onRiskRemediation,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      vscode.window.showErrorMessage(`Failed to remediate: ${message}`);
      throw error;
    }
  }
}

class PackageJsonRemediation extends BaseRemediation {
  canHandle(filename: string): boolean {
    return filename === "package.json";
  }

  async validateDependency(
    originalText: string,
    depKey: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<boolean> {
    const trimmedLine = originalText.trim();
    const previousText = document.getText(
      new vscode.Range(0, 0, lineNumber, 0),
    );
    const inDependencyBlock = /["'](?:dev)?dependencies["']\s*:\s*{/.test(
      previousText,
    );

    // Handle all valid JSON/NPM patterns:
    // - Version numbers with ^, ~, *, x
    // - Git URLs
    // - File paths
    // - npm aliases
    // - Workspace references
    // - Tarball URLs
    const isValidDependency =
      /^\s*["'][^"']+["']\s*:\s*["'](?:[\^~*\d\sx\.><= -]+|(?:git(?:\+ssh)?|http[s]?):\/\/[^\s"']+|file:[^\s"']+|npm:[^\s"']+|workspace:[^\s"']+|[^\s"']+\.tgz)["']\s*,?\s*$/.test(
        trimmedLine,
      );

    return inDependencyBlock && isValidDependency;
  }

  async createUpdatedLineText(
    originalText: string,
    depKey: string,
    fixVersion: string,
  ): Promise<string> {
    // Match the entire dependency line pattern including optional comma and whitespace
    const lineMatch = originalText.match(
      /^(\s*"[^"]+"\s*:\s*)(["'])([^"']+)\2(,?\s*)$/,
    );
    if (!lineMatch) {
      return originalText;
    }

    const [, prefix, quote, currentVersion, suffix] = lineMatch;

    // Don't modify special version formats
    if (
      currentVersion.includes("://") ||
      currentVersion.startsWith("file:") ||
      currentVersion.startsWith("npm:") ||
      currentVersion.startsWith("workspace:") ||
      currentVersion.endsWith(".tgz")
    ) {
      return originalText;
    }

    // Extract version prefix (^, ~, etc)
    const versionPrefix =
      currentVersion.match(/^(\^|~|>=|<=|>|<|\*)?/)?.[1] || "";

    return `${prefix}${quote}${versionPrefix}${fixVersion}${quote}${suffix}`;
  }
}

class RequirementsTxtRemediation extends BaseRemediation {
  canHandle(filename: string): boolean {
    return filename === "requirements.txt";
  }

  async validateDependency(
    originalText: string,
    depKey: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<boolean> {
    const line = originalText.trim();

    // Skip comments and empty lines
    if (line.startsWith("#") || !line) {
      return false;
    }

    // Extract just the package name from depKey (remove version if present)
    const packageName = depKey.split(":")[0].trim();

    // Package name can be case-insensitive
    const escapedDepKey = packageName.replace(
      /[-[\]{}()*+?.,\\^$|#\s]/g,
      "\\$&",
    );
    const packagePattern = new RegExp(
      `^${escapedDepKey}(?:\\[.*?\\])?\\s*(?:~=|==|>=|<=|!=|>|<|===)\\s*[\\d\\w.*+!-]+(?:\\s*;.*)?(?:\\s*#.*)?$`,
      "i",
    );

    return packagePattern.test(line);
  }

  async createUpdatedLineText(
    originalText: string,
    depKey: string,
    fixVersion: string,
  ): Promise<string> {
    // Extract just the package name from depKey (remove version if present)
    const packageName = depKey.split(":")[0].trim();

    // Match all components of a requirements.txt line
    const parts = originalText.match(
      /^(\s*)([^[\s]+)(\[.*?\])?(\s*)(~=|===|==|>=|<=|!=|>|<)(\s*)([^\s;#]+)(\s*(?:;.*)?(?:#.*)?)?$/,
    );

    if (!parts) {
      return originalText;
    }

    const [
      ,
      indentation, // Leading whitespace
      _packageName, // Original package name (ignored, using from depKey)
      extras, // Optional extras in [...]
      spaceAfterPkg, // Space between package and operator
      operator, // Version operator
      spaceAfterOp, // Space between operator and version
      _version, // Original version (ignored, using fixVersion)
      comments, // Optional environment markers and comments
    ] = parts;

    const packageWithExtras = extras ? `${packageName}${extras}` : packageName;

    return `${indentation}${packageWithExtras}${spaceAfterPkg}${operator}${spaceAfterOp}${fixVersion}${comments || ""}`;
  }
}

class PomXmlRemediation extends BaseRemediation {
  canHandle(filename: string): boolean {
    return filename === "pom.xml";
  }

  private async findDependencyContext(
    document: vscode.TextDocument,
    lineNumber: number,
    groupId: string,
    artifactId: string,
  ): Promise<{ startLine: number; endLine: number } | null> {
    let dependencyStart = -1;
    let dependencyEnd = -1;
    let currentGroupId = "";
    let currentArtifactId = "";
    let inDependency = false;

    const startSearch = Math.max(0, lineNumber - 10);
    const endSearch = Math.min(document.lineCount, lineNumber + 10);

    for (let i = startSearch; i < endSearch; i++) {
      const line = document.lineAt(i).text.trim();

      if (line.includes("<dependency>")) {
        dependencyStart = i;
        inDependency = true;
        currentGroupId = "";
        currentArtifactId = "";
      } else if (line.includes("</dependency>")) {
        dependencyEnd = i;
        if (currentGroupId === groupId && currentArtifactId === artifactId) {
          return { startLine: dependencyStart, endLine: dependencyEnd };
        }
        inDependency = false;
      } else if (inDependency) {
        if (line.includes("<groupId>")) {
          currentGroupId = line.replace(/<\/?groupId>/g, "").trim();
        } else if (line.includes("<artifactId>")) {
          currentArtifactId = line.replace(/<\/?artifactId>/g, "").trim();
        }
      }
    }

    return null;
  }

  async validateDependency(
    originalText: string,
    depKey: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<boolean> {
    try {
      const [groupId, artifactId] = depKey.split(":");
      if (!groupId || !artifactId) return false;

      const context = await this.findDependencyContext(
        document,
        lineNumber,
        groupId,
        artifactId,
      );
      return context !== null;
    } catch {
      return false;
    }
  }

  async createUpdatedLineText(
    originalText: string,
    depKey: string,
    fixVersion: string,
    document: vscode.TextDocument,
    lineNumber: number,
  ): Promise<string> {
    if (originalText.includes("<version>")) {
      const indentation = originalText.match(/^\s*/)?.[0] || "";
      return `${indentation}<version>${fixVersion}</version>`;
    }

    const [groupId, artifactId] = depKey.split(":");
    const context = await this.findDependencyContext(
      document,
      lineNumber,
      groupId,
      artifactId,
    );

    if (context) {
      const indentation = originalText.match(/^\s*/)?.[0] || "";
      return `${indentation}<version>${fixVersion}</version>`;
    }

    vscode.window.showErrorMessage(
      "Could not locate appropriate position for version update",
    );
    return "";
  }
}
