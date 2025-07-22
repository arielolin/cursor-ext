import * as vscode from "vscode";
import {
  InventoryService,
  inventoryService,
} from "../../../services/inventory-service";
import {
  ApiItem,
  CategorizedInventory,
  DependencyItem,
  SensitiveDataItem,
} from "../../../types/inventory";
import { TreeItemCollapsibleState } from "vscode";
import { Repository } from "../../../types/repository";

export class InventoryTreeProvider
  implements vscode.TreeDataProvider<InventoryTreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    InventoryTreeItem | undefined | null | void
  > = new vscode.EventEmitter<InventoryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    InventoryTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private data: CategorizedInventory | undefined;
  private service: InventoryService;
  private title: string;
  private description: string;

  constructor(private repoData: Repository) {
    this.service = InventoryService.getInstance();
    this.title = repoData.name;
    this.description = repoData.url;
    this.setupControls();
  }

  private async setupControls() {
    // Register sort command
    vscode.commands.registerCommand("inventory.sort", async () => {
      const sortOptions = ["name", "riskLevel"];
      const sortBy = await vscode.window.showQuickPick(sortOptions, {
        placeHolder: "Sort by...",
      });
      if (sortBy) {
        const direction = await vscode.window.showQuickPick(["asc", "desc"], {
          placeHolder: "Sort direction...",
        });
        if (direction) {
          this.service.setControls({
            sortBy: sortBy as "name" | "riskLevel",
            sortDirection: direction as "asc" | "desc",
          });
          this.refresh();
        }
      }
    });

    vscode.commands.registerCommand("inventory.filter", async () => {
      const riskLevels = ["Critical", "High", "Medium", "Low", "None"];
      const currentFilter = this.service.getControls().riskLevelFilter;

      // Create QuickPick items with checked state
      const quickPickItems = riskLevels.map((level) => ({
        label: level,
        picked: currentFilter.includes(level),
      }));

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: "Select business impact levels to show",
        canPickMany: true,
      });

      if (selected) {
        // Extract just the labels from selected items
        const selectedLevels = selected.map((item) => item.label);
        this.service.setControls({ riskLevelFilter: selectedLevels });
        this.refresh();
      }
    });
  }

  refresh(): void {
    this.data = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: InventoryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: InventoryTreeItem): Promise<InventoryTreeItem[]> {
    if (!this.data) {
      try {
        this.data = await inventoryService.getInventoryData(this.repoData.key);
      } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
        return [];
      }
    }

    if (!element) {
      // Add title and description at the root level
      return [
        new InventoryTreeItem(
          this.title,
          this.description,
          vscode.TreeItemCollapsibleState.None,
          "title",
        ),
        new InventoryTreeItem(
          "Dependencies",
          `(${this.data.dependencies.total})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          "category",
        ),
        new InventoryTreeItem(
          "APIs",
          `(${this.data.apis.total})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          "category",
        ),
        new InventoryTreeItem(
          "Sensitive Data",
          `(${this.data.sensitiveData.total})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          "category",
        ),
        new InventoryTreeItem(
          "Security Controls",
          `(${this.data.security.total})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          "category",
        ),
      ];
    }

    // Handle subcategories based on parent item
    switch (element.label) {
      case "Dependencies":
        return this.getDependencyItems();
      case "APIs":
        return this.getApiItems();
      case "Sensitive Data":
        return this.getSensitiveDataItems();
      case "Security Controls":
        return this.getSecurityItems();
      default:
        return [];
    }
  }

  private getDependencyItems(): InventoryTreeItem[] {
    if (!this.data) return [];

    const directItems = this.data.dependencies.direct.map((dep) =>
      this.createDependencyTreeItem(dep, "Direct"),
    );
    const subItems = this.data.dependencies.sub.map((dep) =>
      this.createDependencyTreeItem(dep, "Transitive"),
    );

    return [...directItems, ...subItems];
  }

  private getApiItems(): InventoryTreeItem[] {
    if (!this.data) return [];

    return this.data.apis.items.map((api) => this.createApiTreeItem(api));
  }

  private getSensitiveDataItems(): InventoryTreeItem[] {
    if (!this.data) return [];

    return this.data.sensitiveData.items.map((item) =>
      this.createSensitiveDataTreeItem(item),
    );
  }

  private getSecurityItems(): InventoryTreeItem[] {
    if (!this.data) return [];

    return this.data.security.items.map((item) => {
      const treeItem = new InventoryTreeItem(
        item.type,
        `${item.httpMethod} ${item.endpoint}`,
        vscode.TreeItemCollapsibleState.None,
        "item",
      );

      if (item.sourceLocation.filePath) {
        treeItem.command = {
          command: "inventory.openFile",
          title: "Open File",
          arguments: [
            item.sourceLocation.filePath,
            item.sourceLocation.lineNumber,
          ],
        };
        treeItem.tooltip = `${item.sourceLocation.filePath}:${item.sourceLocation.lineNumber}`;
      }

      return treeItem;
    });
  }

  private createDependencyTreeItem(
    dep: DependencyItem,
    type: string,
  ): InventoryTreeItem {
    const treeItem = new InventoryTreeItem(
      dep.name,
      `${dep.version} (${type})`,
      vscode.TreeItemCollapsibleState.None,
      "item",
    );

    if (dep.sourceLocation.filePath) {
      treeItem.command = {
        command: "inventory.openFile",
        title: "Open File",
        arguments: [dep.sourceLocation.filePath, dep.sourceLocation.lineNumber],
      };
      treeItem.tooltip = `${dep.sourceLocation.filePath}:${dep.sourceLocation.lineNumber}`;
    }

    return treeItem;
  }

  private createApiTreeItem(api: ApiItem): InventoryTreeItem {
    const treeItem = new InventoryTreeItem(
      api.name,
      `${api.httpMethod} ${api.endpoint}`,
      vscode.TreeItemCollapsibleState.None,
      "item",
    );

    if (api.sourceLocation.filePath) {
      treeItem.command = {
        command: "inventory.openFile",
        title: "Open File",
        arguments: [api.sourceLocation.filePath, api.sourceLocation.lineNumber],
      };
      treeItem.tooltip = `${api.sourceLocation.filePath}:${api.sourceLocation.lineNumber}`;
    }

    // Add icon for public APIs
    if (api.isPublic) {
      treeItem.iconPath = new vscode.ThemeIcon("globe");
    }

    return treeItem;
  }

  private createSensitiveDataTreeItem(
    item: SensitiveDataItem,
  ): InventoryTreeItem {
    const treeItem = new InventoryTreeItem(
      item.fieldName,
      `${item.className} (${item.types.join(", ")})`,
      vscode.TreeItemCollapsibleState.None,
      "item",
    );

    if (item.sourceLocation.filePath) {
      treeItem.command = {
        command: "inventory.openFile",
        title: "Open File",
        arguments: [
          item.sourceLocation.filePath,
          item.sourceLocation.lineNumber,
        ],
      };
      treeItem.tooltip = `${item.sourceLocation.filePath}:${item.sourceLocation.lineNumber}`;
    }

    // Add icon for exposed sensitive data
    if (item.isExposed) {
      treeItem.iconPath = new vscode.ThemeIcon("shield");
    }

    return treeItem;
  }
}

class InventoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: TreeItemCollapsibleState,
    public readonly itemType: "title" | "category" | "item",
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.contextValue = itemType;

    // Add special styling for title
    if (itemType === "title") {
      this.iconPath = new vscode.ThemeIcon("git-branch");
    }
  }
}
