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
    return this.itemsView
      .getSortedItems()
      .filter((item: Zotero.Item) => !item.parentItemID);
  }

  getSelectedIDs(): number[] {
    return this.win.ZoteroPane.getSelectedItems(true);
  }

  async selectItem(itemID: number): Promise<void> {
    await this.itemsView.selectItem(itemID);
  }

  async selectItems(itemIDs: number[]): Promise<void> {
    if (!itemIDs.length) {
      this.itemsView.selection.clearSelection();
      return;
    }
    await this.win.ZoteroPane.selectItems(itemIDs, true);
  }

  async activateItem(itemID: number): Promise<void> {
    const item = await Zotero.Items.getAsync(itemID);
    if (item) {
      await this.win.ZoteroPane.viewItems(
        [item],
        new this.win.MouseEvent("dblclick"),
      );
    }
  }

  async activateSelectedItems(): Promise<void> {
    const itemIDs = this.getSelectedIDs();
    if (!itemIDs.length || itemIDs.length >= ACTIVATION_ITEM_LIMIT) return;
    const items = await Zotero.Items.getAsync(itemIDs);
    if (items.length) {
      await this.win.ZoteroPane.viewItems(
        items,
        new this.win.KeyboardEvent("keydown", { key: "Enter" }),
      );
    }
  }

  async deleteSelectedItems(force: boolean): Promise<void> {
    if (!this.getSelectedIDs().length) return;
    await this.win.ZoteroPane.deleteSelectedItems(force);
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

const ACTIVATION_ITEM_LIMIT = 20;
