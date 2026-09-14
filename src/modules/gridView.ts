import { GridRenderer } from "./gridRenderer";

const gridViews = new Map<Window, GridView>();

type StylableElement = Element & { style: CSSStyleDeclaration };
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

function registerStyleSheet(win: _ZoteroTypes.MainWindow): HTMLLinkElement {
  const styles = ztoolkit.UI.createElement(win.document, "link", {
    namespace: "html",
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/coverView.css`,
    },
  });
  win.document.documentElement?.appendChild(styles);
  return styles;
}

export class GridView {
  private readonly itemsView: ItemsView;
  private readonly itemTree: StylableElement;
  private readonly gridHost: HTMLDivElement;
  private readonly stylesheet: HTMLLinkElement;
  private readonly renderer: GridRenderer;
  private readonly itemTreeDisplay: string;
  private readonly removeListeners: Array<() => void> = [];
  private syncTimer?: number;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    const itemTree = win.document.getElementById(
      "zotero-items-tree",
    ) as StylableElement | null;
    if (!itemTree) {
      throw new Error(
        "Cannot attach grid view: #zotero-items-tree was not found",
      );
    }
    const itemsView = win.ZoteroPane.itemsView as ItemsView | false;
    if (!itemsView) {
      throw new Error("Cannot attach grid view: itemsView is not available");
    }

    this.itemsView = itemsView;
    this.itemTree = itemTree;
    this.itemTreeDisplay = itemTree.style.display;
    this.stylesheet = registerStyleSheet(win);

    this.gridHost = win.document.createElement("div");
    this.gridHost.id = "cover-view-grid";
    this.gridHost.hidden = true;
    itemTree.after(this.gridHost);
    this.renderer = new GridRenderer(this.gridHost);
    this.listenForItemChanges();
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.itemTree.style.display = enabled ? "none" : this.itemTreeDisplay;
    this.gridHost.hidden = !enabled;
    if (enabled) this.syncItems();
  }

  destroy(): void {
    if (this.syncTimer !== undefined) {
      this.win.clearTimeout(this.syncTimer);
    }
    for (const removeListener of this.removeListeners) removeListener();

    this.itemTree.style.display = this.itemTreeDisplay;
    this.renderer.destroy();
    this.gridHost.remove();
    this.stylesheet.remove();
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
