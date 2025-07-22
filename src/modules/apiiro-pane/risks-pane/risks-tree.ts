import vscode, { TreeItemCollapsibleState } from "vscode";
import { Risk, RISK_CATEGORIES, riskLevels } from "../../../types/risk";
import { Repository } from "../../../types/repository";
import { riskService } from "../../../services/repo-risks-service";

export class RisksTreeProvider
  implements vscode.TreeDataProvider<RiskTreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    RiskTreeItem | undefined | null | void
  > = new vscode.EventEmitter<RiskTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    RiskTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private risks: Risk[] = [];
  private loading: boolean = false;
  private categories: { [key: string]: Risk[] } = {};
  private initialized: boolean = false;
  private outputChannel: vscode.OutputChannel;

  constructor(private repoData: Repository) {
    this.outputChannel = vscode.window.createOutputChannel(
      "Risks Tree Provider",
    );
  }

  private log(message: string) {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  refresh(): void {
    this.log("Refreshing tree view");
    this.initialized = false;
    this.risks = [];
    this.categories = {};
    this._onDidChangeTreeData.fire();
  }

  async filter() {
    this.log("Opening risk level filter dialog");
    const levels = Object.values(riskLevels);
    const quickPickItems = levels.map((level) => ({
      label: level,
      picked: true,
    }));

    const selected = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: "Select risk levels to show",
      canPickMany: true,
    });

    if (selected) {
      const selectedLevels = selected.map((item) => item.label);
      this.log(`Filtering risks by levels: ${selectedLevels.join(", ")}`);
      this.filterRisksByLevel(selectedLevels);
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: RiskTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RiskTreeItem): Promise<RiskTreeItem[]> {
    if (!this.initialized) {
      await this.loadRisks();
      this.initialized = true;
    }

    if (this.loading) {
      return [
        new RiskTreeItem(
          "Loading...",
          "",
          TreeItemCollapsibleState.None,
          "loading",
        ),
      ];
    }

    if (!element) {
      return this.getRootItems();
    }

    return this.getChildItems(element);
  }

  private getRootItems(): RiskTreeItem[] {
    this.log("Building root tree items");

    return Object.entries(RISK_CATEGORIES)
      .map(([category, displayName]) => {
        const count = this.categories[category]?.length || 0;
        this.log(`Category ${displayName} has ${count} risks`);

        return {
          treeItem: new RiskTreeItem(
            displayName as string,
            count > 0 ? `(${count})` : "(Empty)",
            TreeItemCollapsibleState.Collapsed,
            "category",
          ),
          category,
          count,
        };
      })
      .sort((a, b) => b.count - a.count) // Sort by count in descending order
      .map((item) => item.treeItem); // Return just the tree items
  }

  private getChildItems(element: RiskTreeItem): RiskTreeItem[] {
    if (element.contextValue !== "category") {
      return [];
    }

    // Find internal category key by display name
    const category = Object.entries(RISK_CATEGORIES).find(
      ([_, displayName]) => displayName === element.label,
    )?.[0];

    if (!category) {
      return [];
    }

    const categoryRisks = this.categories[category] || [];
    this.log(
      `Getting child items for category ${element.label}: ${categoryRisks.length} risks`,
    );
    return categoryRisks
      .map((risk) => this.createRiskTreeItem(risk))
      .filter(Boolean);
  }

  private async loadRisks() {
    if (this.loading) {
      return;
    }

    this.log(`Loading risks for repo: ${this.repoData.key}`);
    this.loading = true;
    this._onDidChangeTreeData.fire();

    try {
      const { risks } = await riskService.getRisksForRepo(this.repoData.key);
      this.risks = risks;
      this.log(`Loaded ${risks.length} risks`);
      this.categorizeRisks();
    } catch (error: any) {
      const errorMessage = `Error loading risks: ${error.message}`;
      this.log(`Error: ${errorMessage}`);
      vscode.window.showErrorMessage(errorMessage);
      this.risks = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private categorizeRisks() {
    this.log("Categorizing risks");

    // Initialize categories with internal names
    this.categories = Object.keys(RISK_CATEGORIES).reduce(
      (acc, category) => {
        acc[category] = [];
        return acc;
      },
      {} as { [key: string]: Risk[] },
    );

    // Log unique categories from the API response
    const uniqueCategories = new Set(
      this.risks.map((risk) => risk.riskCategory),
    );
    this.log(
      "Unique categories in response: " +
        Array.from(uniqueCategories).join(", "),
    );

    let totalCategorized = 0;

    // Map risks to internal categories
    for (const risk of this.risks) {
      // Find internal category by comparing with the API response category
      const internalCategory = Object.entries(RISK_CATEGORIES).find(
        ([_, displayName]) =>
          displayName.toLowerCase() === risk.riskCategory.toLowerCase(),
      )?.[0];

      if (internalCategory) {
        this.categories[internalCategory].push(risk);
        totalCategorized++;
      } else {
        this.log(`Unmatched category found: ${risk.riskCategory}`);
      }
    }

    this.log(`Total risks categorized: ${totalCategorized}`);
    this.log(
      "Categories distribution: " +
        Object.entries(this.categories)
          .map(
            ([category, risks]) =>
              `${category} (${RISK_CATEGORIES[category as keyof typeof RISK_CATEGORIES]}): ${risks.length}`,
          )
          .join(", "),
    );
  }

  private filterRisksByLevel(levels: string[]) {
    this.log(`Filtering risks by levels: ${levels.join(", ")}`);
    this.risks = this.risks.filter((risk) => levels.includes(risk.riskLevel));
    this.categorizeRisks();
  }

  private createRiskTreeItem(risk: Risk): RiskTreeItem {
    if (!risk.sourceCode.lineNumber || risk.sourceCode.lineNumber === 0) {
      //@ts-ignore
      return null;
    }
    const label = risk.ruleName;
    const description = `${risk.riskLevel} - ${risk.riskStatus}`;
    const treeItem = new RiskTreeItem(
      label,
      description,
      TreeItemCollapsibleState.None,
      "risk",
    );

    let iconName = "info";
    switch (risk.riskLevel) {
      case riskLevels.Critical:
        iconName = "error";
        break;
      case riskLevels.High:
      case riskLevels.Medium:
        iconName = "warning";
        break;
      case riskLevels.Low:
        iconName = "info";
        break;
    }
    treeItem.iconPath = new vscode.ThemeIcon(iconName);

    if (risk.sourceCode?.filePath) {
      treeItem.command = {
        command: "risks.openFile",
        title: "Open File",
        arguments: [risk.sourceCode.filePath, risk.sourceCode.lineNumber],
      };
      treeItem.tooltip = `${risk.sourceCode.filePath}:${risk.sourceCode.lineNumber}`;
    }

    return treeItem;
  }
}

class RiskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: TreeItemCollapsibleState,
    public readonly contextValue: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.contextValue = contextValue;
  }
}
