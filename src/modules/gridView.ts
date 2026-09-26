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
  private focusFrame?: number;
  private readonly selectionTimer: number;
  private itemIDs: number[] = [];
  private focusedItemID?: number;
  private selectionAnchorID?: number;
  private selectedIDs: number[] = [];
  private pendingSelections = 0;
  private focusOwner?: "grid" | "tree";

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    this.tree = new ItemTreeBridge(win);
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(
      this.ui.host,
      this.selectClickedItem,
      this.activateClickedItem,
      this.navigate,
      this.onGridFocus,
      this.handleItemCommand,
    );
    this.tree.onItemsChanged(this.scheduleSync);
    // Programmatic native selection changes do not emit row-provider updates.
    this.selectionTimer = win.setInterval(() => {
      if (!getPref("enableGridView") || this.pendingSelections) return;
      const selected = this.tree.getSelectedIDs();
      if (
        selected.length !== this.selectedIDs.length ||
        selected.some((id) => !this.selectedIDs.includes(id))
      ) {
        this.scheduleSync();
      }
    }, 150);
    win.document.addEventListener("focusin", this.trackFocus);
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
    const enabled = !!getPref("enableGridView");
    const active = this.win.document.activeElement;
    const outgoingOwner = this.ui.ownsGridFocus(active)
      ? "grid"
      : this.ui.ownsTreeFocus(active)
        ? "tree"
        : this.focusOwner;
    const enteringGrid = enabled && !!this.ui.host.hidden;
    this.cancelSync();
    if (this.focusFrame !== undefined) {
      this.win.cancelAnimationFrame(this.focusFrame);
      this.focusFrame = undefined;
    }
    this.ui.setEnabled(enabled);
    if (!enabled) this.tree.refreshLayout();
    this.syncItems(enteringGrid);
    if (outgoingOwner === (enabled ? "tree" : "grid")) {
      if (enabled) this.ui.host.focus();
      else {
        // Zotero's virtualized tree is not focusable until its newly shown
        // layout has completed after the preference observer runs.
        const currentFocus = this.win.document.activeElement;
        this.focusFrame = this.win.requestAnimationFrame(() => {
          this.focusFrame = undefined;
          if (
            !getPref("enableGridView") &&
            this.win.document.activeElement === currentFocus
          ) {
            this.tree.focus();
            if (this.ui.ownsTreeFocus(this.win.document.activeElement)) {
              this.focusOwner = "tree";
            }
          }
        });
      }
    }
  }

  readonly toggleEnabled = (): void => {
    setPref("enableGridView", !getPref("enableGridView"));
  };

  destroy(): void {
    if (this.focusFrame !== undefined)
      this.win.cancelAnimationFrame(this.focusFrame);
    this.win.clearInterval(this.selectionTimer);
    this.win.document.removeEventListener("focusin", this.trackFocus);
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
    this.pendingSelections++;
    try {
      await this.tree.selectItems(itemIDs);
      this.selectedIDs = this.tree.getSelectedIDs();
      if (getPref("enableGridView")) {
        this.renderer.setSelection(this.selectedIDs);
      }
    } finally {
      this.pendingSelections--;
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
    if (!this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      this.selectionAnchorID = this.focusedItemID;
    }
  };

  private readonly onGridFocus = (): void => {
    // Catch native selection changes before the periodic check runs when a
    // user moves keyboard focus into the grid.
    this.syncItems();
  };

  private readonly trackFocus = (event: FocusEvent): void => {
    const target = event.target as Element | null;
    if (this.ui.ownsGridFocus(target)) this.focusOwner = "grid";
    else if (this.ui.ownsTreeFocus(target)) this.focusOwner = "tree";
    else if (!this.ui.isToggle(target)) this.focusOwner = undefined;
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

  private syncItems(preserveFocusOnEntry = false): void {
    if (!getPref("enableGridView")) return;
    if (this.win.Zotero_Tabs.selectedType !== "library") return;
    const items = this.tree.getItems();
    const previousIDs = this.itemIDs;
    this.itemIDs = items.map((item) => item.id);
    const selectedIDs = this.tree.getSelectedIDs();
    const selectionChanged =
      selectedIDs.length !== this.selectedIDs.length ||
      selectedIDs.some((id) => !this.selectedIDs.includes(id));
    const additions = selectedIDs.filter(
      (id) => !this.selectedIDs.includes(id),
    );
    this.selectedIDs = selectedIDs;

    if (
      preserveFocusOnEntry &&
      !this.itemIDs.includes(this.focusedItemID ?? NaN)
    ) {
      const selected = new Set(selectedIDs);
      this.focusedItemID =
        this.itemIDs.findLast((id) => selected.has(id)) ?? this.itemIDs[0];
    } else if (!this.itemIDs.includes(this.focusedItemID ?? NaN)) {
      const oldIndex = previousIDs.indexOf(this.focusedItemID ?? NaN);
      this.focusedItemID =
        oldIndex < 0
          ? undefined
          : (previousIDs
              .slice(0, oldIndex)
              .reverse()
              .find((id) => this.itemIDs.includes(id)) ?? this.itemIDs[0]);
    } else if (
      !preserveFocusOnEntry &&
      !this.pendingSelections &&
      selectionChanged &&
      selectedIDs.length
    ) {
      this.focusedItemID =
        (additions.length === 1 && this.itemIDs.includes(additions[0])
          ? additions[0]
          : undefined) ??
        this.itemIDs.findLast((id) => selectedIDs.includes(id)) ??
        this.focusedItemID;
    }
    if (!this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      this.selectionAnchorID = this.focusedItemID;
    }
    this.renderer.setItems(items, {
      showAuthors: getPref("showAuthors"),
    });
    this.renderer.setSelection(selectedIDs);
    if (!this.itemIDs.length) {
      this.focusedItemID = undefined;
      this.selectionAnchorID = undefined;
      this.renderer.setFocusedItem(undefined);
    } else if (this.ui.ownsGridFocus(this.win.document.activeElement)) {
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
