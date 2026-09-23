import { GridRenderer } from "./gridRenderer";
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
      (itemID) => {
        void this.tree.activateItem(itemID).catch((error) => {
          ztoolkit.log("Failed to activate grid item", itemID, error);
        });
      },
      this.navigateHorizontally,
      this.ensureGridFocus,
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

  private async selectItem(itemID: number): Promise<void> {
    await this.tree.selectItem(itemID);
    if (getPref("enableGridView")) {
      this.renderer.setSelection(this.tree.getSelectedIDs());
    }
  }

  private readonly selectClickedItem = (itemID: number): void => {
    this.focusedItemID = itemID;
    this.selectionAnchorID = itemID;
    this.renderer.setFocusedItem(itemID);
    void this.selectItem(itemID).catch((error) => {
      ztoolkit.log("Failed to select grid item", itemID, error);
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

  private readonly navigateHorizontally = (direction: -1 | 1): void => {
    this.ensureGridFocus();
    if (this.focusedItemID === undefined) return;

    const currentIndex = this.itemIDs.indexOf(this.focusedItemID);
    const destinationIndex = currentIndex + direction;
    if (destinationIndex < 0 || destinationIndex >= this.itemIDs.length) return;

    const destinationID = this.itemIDs[destinationIndex];
    this.focusedItemID = destinationID;
    this.selectionAnchorID = destinationID;
    this.renderer.setFocusedItem(destinationID, true);
    void this.selectItem(destinationID).catch((error) => {
      ztoolkit.log("Failed to navigate to grid item", destinationID, error);
      if (getPref("enableGridView")) {
        this.renderer.setSelection(this.tree.getSelectedIDs());
      }
    });
  };

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
