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

  /** Return top-level items in the native view's current sort order. */
  getItems(): Zotero.Item[] {
    return this.itemsView.getSortedItems().filter((item) => !item.parentItemID);
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
