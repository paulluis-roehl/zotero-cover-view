import { GridRenderer } from "./gridRenderer";
import { GridWindowUI } from "./gridWindowUI";

const gridViews = new Map<Window, GridView>();

type ListenerEvent = {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
};
type ItemsView = _ZoteroTypes.ItemTree & {
  getSortedItems(): Zotero.Item[];
};
type CollectionsView = _ZoteroTypes.CollectionTree & {
  onSelect?: ListenerEvent;
};

export class GridView {
  private readonly itemsView: ItemsView;
  private readonly ui: GridWindowUI;
  private readonly renderer: GridRenderer;
  private readonly removeListeners: Array<() => void> = [];
  private enabled = false;
  private syncTimer?: number;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    const itemsView = win.ZoteroPane.itemsView as ItemsView | false;
    if (!itemsView) {
      throw new Error("Cannot attach grid view: itemsView is not available");
    }
    this.itemsView = itemsView;
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(this.ui.host);
    this.listenForItemChanges();
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.ui.setEnabled(enabled);
    if (enabled) this.syncItems();
  }

  readonly toggleEnabled = (): void => {
    this.setEnabled(!this.enabled);
  };

  destroy(): void {
    if (this.syncTimer !== undefined) {
      this.win.clearTimeout(this.syncTimer);
    }
    for (const removeListener of this.removeListeners) removeListener();

    this.renderer.destroy();
    this.ui.destroy();
  }

  private listenForItemChanges(): void {
    const rowUpdates = this.itemsView.rowProvider?.onUpdate;
    if (rowUpdates) {
      rowUpdates.addListener(this.scheduleSync);
      this.removeListeners.push(() =>
        rowUpdates.removeListener(this.scheduleSync),
      );
    }

    const collectionsView = this.win.ZoteroPane.collectionsView as
      CollectionsView | false;
    const collectionSelect = collectionsView && collectionsView.onSelect;
    if (collectionSelect) {
      collectionSelect.addListener(this.scheduleSync);
      this.removeListeners.push(() =>
        collectionSelect.removeListener(this.scheduleSync),
      );
    }
  }

  private readonly scheduleSync = (): void => {
    if (this.syncTimer !== undefined) {
      this.win.clearTimeout(this.syncTimer);
    }
    this.syncTimer = this.win.setTimeout(() => {
      this.syncTimer = undefined;
      this.syncItems();
    }, 60);
  };

  private syncItems(): void {
    const items = this.itemsView
      .getSortedItems()
      .filter((item) => !item.parentItemID);
    this.renderer.setItems(items);
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
