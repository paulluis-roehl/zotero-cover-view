import { GridRenderer } from "./gridRenderer";
import { GridWindowUI } from "./gridWindowUI";
import { ItemTreeBridge } from "./itemTreeBridge";

const gridViews = new Map<Window, GridView>();

export class GridView {
  private readonly tree: ItemTreeBridge;
  private readonly ui: GridWindowUI;
  private readonly renderer: GridRenderer;
  private enabled = false;
  private syncTimer?: number;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    this.tree = new ItemTreeBridge(win);
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(this.ui.host, (itemID) => {
      void this.selectItem(itemID).catch((error) => {
        ztoolkit.log("Failed to select grid item", itemID, error);
      });
    });
    this.tree.onItemsChanged(this.scheduleSync);
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.cancelSync();
    this.ui.setEnabled(enabled);
    if (!enabled) this.tree.refreshLayout();
    this.syncItems();
  }

  readonly toggleEnabled = (): void => {
    this.setEnabled(!this.enabled);
  };

  destroy(): void {
    this.enabled = false;
    this.cancelSync();
    this.tree.destroy();

    this.renderer.destroy();
    this.ui.destroy();
  }

  private readonly scheduleSync = (): void => {
    if (!this.enabled) return;
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
    if (this.enabled) {
      this.renderer.setSelection(this.tree.getSelectedIDs());
    }
  }

  private syncItems(): void {
    if (!this.enabled) return;
    this.renderer.setItems(this.tree.getItems());
    this.renderer.setSelection(this.tree.getSelectedIDs());
  }
}

export function attachGridView(win: _ZoteroTypes.MainWindow): GridView {
  const existing = gridViews.get(win);
  if (existing) return existing;

  const gridView = new GridView(win);
  gridViews.set(win, gridView);
  return gridView;
}

export function detachGridView(win: Window): void {
  const gridView = gridViews.get(win);
  if (!gridView) return;

  gridView.destroy();
  gridViews.delete(win);
}

export function destroyGridViews(): void {
  for (const gridView of gridViews.values()) {
    gridView.destroy();
  }
  gridViews.clear();
}
