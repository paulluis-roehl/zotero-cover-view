type ListenerEvent = {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
};
type ItemsView = _ZoteroTypes.ItemTree & {
  _treebox?: { update(): void };
  tree?: { invalidate(): void };
};
type CollectionsView = _ZoteroTypes.CollectionTree & {
  onSelect?: ListenerEvent;
};

export class ItemTreeBridge {
  private readonly itemsView: ItemsView;
  private readonly removeListeners = new Set<() => void>();

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    const itemsView = win.ZoteroPane.itemsView as ItemsView | false;
    if (!itemsView) {
      throw new Error("Cannot attach grid view: itemsView is not available");
    }
    this.itemsView = itemsView;
  }

  getItems(): Zotero.Item[] {
    return this.win.ZoteroPane.getSortedItems().filter(
      (item) => !item.parentItemID,
    );
  }

  getSelectedIDs(): number[] {
    return this.win.ZoteroPane.getSelectedItems(true);
  }

  async selectItem(itemID: number): Promise<void> {
    await this.win.ZoteroPane.selectItems([itemID]);
  }

  /** Call after showing the native tree, when DOM measurements are available. */
  refreshLayout(): void {
    // Hidden selection/scroll updates can leave the windowed list's cached
    // scroll offset out of step with the DOM. update() reads the actual offset;
    // invalidate() then rebuilds the visible rows and updates column widths.
    this.itemsView._treebox?.update();
    this.itemsView.tree?.invalidate();
  }

  onItemsChanged(callback: () => void): () => void {
    const removeListeners: Array<() => void> = [];
    const rowUpdates = this.itemsView.rowProvider?.onUpdate;
    if (rowUpdates) {
      rowUpdates.addListener(callback);
      removeListeners.push(() => rowUpdates.removeListener(callback));
    }

    const collectionsView = this.win.ZoteroPane.collectionsView as
      CollectionsView | false;
    const collectionSelect = collectionsView && collectionsView.onSelect;
    if (collectionSelect) {
      collectionSelect.addListener(callback);
      removeListeners.push(() => collectionSelect.removeListener(callback));
    }

    const unsubscribe = (): void => {
      if (!this.removeListeners.delete(unsubscribe)) return;
      for (const removeListener of removeListeners) removeListener();
    };
    this.removeListeners.add(unsubscribe);
    return unsubscribe;
  }

  destroy(): void {
    for (const removeListener of this.removeListeners) removeListener();
  }
}
