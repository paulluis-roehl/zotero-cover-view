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

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    this.tree = new ItemTreeBridge(win);
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(
      this.ui.host,
      (itemID) => {
        void this.selectItem(itemID).catch((error) => {
          ztoolkit.log("Failed to select grid item", itemID, error);
        });
      },
      (itemID) => {
        void this.tree.activateItem(itemID).catch((error) => {
          ztoolkit.log("Failed to activate grid item", itemID, error);
        });
      },
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

  private syncItems(): void {
    if (!getPref("enableGridView")) return;
    if (this.win.Zotero_Tabs.selectedType !== "library") return;
    this.renderer.setItems(this.tree.getItems(), {
      showAuthors: getPref("showAuthors"),
    });
    this.renderer.setSelection(this.tree.getSelectedIDs());
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
