import {
  GridNavigationCommand,
  GridItemCommand,
  GridItemCommandOptions,
  GridRenderer,
  GridSelectionModifiers,
} from "./gridRenderer";
import { GridWindowUI } from "./gridWindowUI";
import { ItemTreeBridge } from "./itemTreeBridge";
import { getPref, observePrefs, setPref } from "../utils/prefs";

const gridViews = new Map<Window, GridView>();
const GRID_RENDER_PREFS = ["showAuthors", "fetchISBNCover"] as const;
let stopObservingPreferences: (() => void) | undefined;

export class GridView {
  private readonly tree: ItemTreeBridge;
  private readonly ui: GridWindowUI;
  private readonly renderer: GridRenderer;
  private readonly tabObserverID: string;
  private syncTimer?: number;
  private itemIDs: number[] = [];
  private focusedItemID?: number;
  private selectionAnchorID?: number;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    this.tree = new ItemTreeBridge(win);
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(
      this.ui.host,
      this.selectClickedItem,
      this.activateClickedItem,
      this.navigate,
      this.ensureGridFocus,
      this.handleItemCommand,
    );
    this.tree.onItemsChanged(this.scheduleSync);
    this.tabObserverID = Zotero.Notifier.registerObserver(
      {
        notify: (event, _type, ids) => {
          if (event === "select" && ids.some((id) => id === "zotero-pane")) {
            this.renderer.refreshLayout();
          }
        },
      },
      ["tab"],
      "cover-view-grid",
    );
    this.applyEnabledPreference();
  }

  applyEnabledPreference(): void {
    const enabled = getPref("enableGridView");
    this.cancelSync();
    this.ui.setEnabled(enabled);
    if (!enabled) this.tree.refreshLayout();
    this.syncItems();
  }

  readonly toggleEnabled = (): void => {
    setPref("enableGridView", !getPref("enableGridView"));
  };

  destroy(): void {
    this.cancelSync();
    this.tree.destroy();
    Zotero.Notifier.unregisterObserver(this.tabObserverID);

    this.renderer.destroy();
    this.ui.destroy();
  }

  readonly scheduleSync = (): void => {
    if (!getPref("enableGridView")) return;
    if (this.win.Zotero_Tabs.selectedType !== "library") return;
    this.cancelSync();
    this.syncTimer = this.win.setTimeout(() => {
      this.syncTimer = undefined;
      this.syncItems();
    }, 60);
  };

  private cancelSync(): void {
    if (this.syncTimer !== undefined) {
      this.win.clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  private async selectItems(itemIDs: number[]): Promise<void> {
    await this.tree.selectItems(itemIDs);
    if (getPref("enableGridView")) {
      this.renderer.setSelection(this.tree.getSelectedIDs());
    }
  }

  private readonly selectClickedItem = (
    itemID: number,
    modifiers: GridSelectionModifiers,
  ): void => {
    this.focusedItemID = itemID;
    this.renderer.setFocusedItem(itemID);
    const anchorID = this.getSelectionAnchor();
    let selectedIDs: number[];
    if (modifiers.shift) {
      const range = this.getRange(anchorID, itemID);
      selectedIDs = modifiers.primary ? this.addToSelection(range) : range;
    } else if (modifiers.primary) {
      this.selectionAnchorID = itemID;
      selectedIDs = this.toggleSelection(itemID);
    } else {
      this.selectionAnchorID = itemID;
      selectedIDs = [itemID];
    }
    void this.selectItems(selectedIDs).catch((error) => {
      ztoolkit.log("Failed to select grid item", itemID, error);
      this.resynchronizeSelection();
    });
  };

  private readonly ensureGridFocus = (): void => {
    if (!this.itemIDs.length) {
      this.focusedItemID = undefined;
      this.selectionAnchorID = undefined;
      this.renderer.setFocusedItem(undefined);
      return;
    }
    if (!this.itemIDs.includes(this.focusedItemID ?? NaN)) {
      const selectedIDs = new Set(this.tree.getSelectedIDs());
      this.focusedItemID =
        this.itemIDs.findLast((itemID) => selectedIDs.has(itemID)) ??
        this.itemIDs[0];
    }
    this.renderer.setFocusedItem(this.focusedItemID);
  };

  private readonly activateClickedItem = (itemID: number): void => {
    void this.tree.activateItem(itemID).catch((error) => {
      ztoolkit.log("Failed to activate grid item", itemID, error);
      this.resynchronizeSelection();
    });
  };

  private readonly handleItemCommand = (
    command: GridItemCommand,
    options: GridItemCommandOptions,
  ): void => {
    switch (command) {
      case "activate":
        void this.tree.activateSelectedItems().catch((error) => {
          ztoolkit.log("Failed to activate selected grid items", error);
          this.resynchronizeSelection();
        });
        return;
      case "toggle-selection":
        this.ensureGridFocus();
        if (this.focusedItemID === undefined) return;
        void this.selectItems(this.toggleSelection(this.focusedItemID)).catch(
          (error) => {
            ztoolkit.log(
              "Failed to toggle focused grid item selection",
              this.focusedItemID,
              error,
            );
            this.resynchronizeSelection();
          },
        );
        return;
      case "delete":
        void this.tree
          .deleteSelectedItems(options.forceDelete ?? false)
          .catch((error) => {
            ztoolkit.log("Failed to delete selected grid items", error);
            this.resynchronizeSelection();
          });
    }
  };

  private readonly navigate = (
    command: GridNavigationCommand,
    modifiers: GridSelectionModifiers,
  ): void => {
    this.ensureGridFocus();
    if (this.focusedItemID === undefined) return;

    const currentIndex = this.itemIDs.indexOf(this.focusedItemID);
    let destinationID: number | undefined;
    switch (command) {
      case "left":
        destinationID = this.itemIDs[currentIndex - 1];
        break;
      case "right":
        destinationID = this.itemIDs[currentIndex + 1];
        break;
      case "up":
      case "down":
        destinationID = this.renderer.getVerticalDestination(
          this.focusedItemID,
          command === "up" ? -1 : 1,
        );
        break;
      case "home":
        destinationID = this.itemIDs[0];
        break;
      case "end":
        destinationID = this.itemIDs.at(-1);
        break;
    }
    if (destinationID === undefined || destinationID === this.focusedItemID)
      return;

    const anchorID = this.getSelectionAnchor();
    this.focusedItemID = destinationID;
    this.renderer.setFocusedItem(destinationID, true);
    if (modifiers.primary && !modifiers.shift) {
      this.selectionAnchorID = destinationID;
      return;
    }

    const selectedIDs = modifiers.shift
      ? modifiers.primary
        ? this.addToSelection(this.getRange(anchorID, destinationID))
        : this.getRange(anchorID, destinationID)
      : [destinationID];
    if (!modifiers.shift) this.selectionAnchorID = destinationID;
    void this.selectItems(selectedIDs).catch((error) => {
      ztoolkit.log("Failed to navigate to grid item", destinationID, error);
      this.resynchronizeSelection();
    });
  };

  private getSelectionAnchor(): number {
    if (this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      return this.selectionAnchorID!;
    }
    this.selectionAnchorID = this.focusedItemID!;
    return this.selectionAnchorID;
  }

  private getRange(startID: number, endID: number): number[] {
    const start = this.itemIDs.indexOf(startID);
    const end = this.itemIDs.indexOf(endID);
    return this.itemIDs.slice(Math.min(start, end), Math.max(start, end) + 1);
  }

  private addToSelection(itemIDs: number[]): number[] {
    return [...new Set([...this.tree.getSelectedIDs(), ...itemIDs])];
  }

  private toggleSelection(itemID: number): number[] {
    const selectedIDs = new Set(this.tree.getSelectedIDs());
    if (selectedIDs.has(itemID)) selectedIDs.delete(itemID);
    else selectedIDs.add(itemID);
    return [...selectedIDs];
  }

  private resynchronizeSelection(): void {
    if (getPref("enableGridView")) {
      this.renderer.setSelection(this.tree.getSelectedIDs());
    }
  }

  private syncItems(): void {
    if (!getPref("enableGridView")) return;
    if (this.win.Zotero_Tabs.selectedType !== "library") return;
    const items = this.tree.getItems();
    this.itemIDs = items.map((item) => item.id);
    this.renderer.setItems(items, {
      showAuthors: getPref("showAuthors"),
    });
    this.renderer.setSelection(this.tree.getSelectedIDs());
    if (!this.itemIDs.length) {
      this.focusedItemID = undefined;
      this.selectionAnchorID = undefined;
      this.renderer.setFocusedItem(undefined);
    } else if (this.ui.host === this.win.document.activeElement) {
      this.ensureGridFocus();
    } else if (this.focusedItemID !== undefined) {
      this.renderer.setFocusedItem(this.focusedItemID);
    }
  }
}

function registerPreferenceObserver(): void {
  if (stopObservingPreferences) return;
  const stopEnabledObserver = observePrefs(["enableGridView"], () => {
    for (const gridView of gridViews.values()) {
      gridView.applyEnabledPreference();
    }
  });
  const stopRenderObserver = observePrefs(GRID_RENDER_PREFS, () => {
    for (const gridView of gridViews.values()) gridView.scheduleSync();
  });
  stopObservingPreferences = () => {
    stopEnabledObserver();
    stopRenderObserver();
  };
}

function unregisterPreferenceObserver(): void {
  stopObservingPreferences?.();
  stopObservingPreferences = undefined;
}

export function attachGridView(win: _ZoteroTypes.MainWindow): GridView {
  const existing = gridViews.get(win);
  if (existing) return existing;

  const gridView = new GridView(win);
  gridViews.set(win, gridView);
  registerPreferenceObserver();
  return gridView;
}

export function detachGridView(win: Window): void {
  const gridView = gridViews.get(win);
  if (!gridView) return;

  gridView.destroy();
  gridViews.delete(win);
  if (!gridViews.size) unregisterPreferenceObserver();
}

export function destroyGridViews(): void {
  for (const gridView of gridViews.values()) {
    gridView.destroy();
  }
  gridViews.clear();
  unregisterPreferenceObserver();
}
