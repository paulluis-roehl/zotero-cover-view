type ListenerEvent = {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
};
type ItemsView = _ZoteroTypes.ItemTree & {
  _treebox?: { update(): void };
  tree?: { invalidate(): void };
  collectionTreeRows?: CollectionDropRow[];
  canDropCheck?: (
    row: number,
    orient: number,
    transfer: DataTransfer,
  ) => boolean;
  onDrop?: (event: DragEvent, row: number) => Promise<void>;
};
type CollectionDropRow = {
  ref: { libraryID: number; id?: number };
  isCollection(): boolean;
  isLibrary(root?: boolean): boolean;
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

  /** Supply the same source row and payload helper used by Zotero's item tree.
   * The collection tree uses this row to decide add/move/copy and invalid drops.
   */
  startItemDrag(event: DragEvent, itemIDs: number[]): void {
    const source = (
      this.itemsView as ItemsView & {
        collectionTreeRows?: Array<unknown>;
      }
    ).collectionTreeRows?.[0];
    const dragDrop = (
      Zotero as typeof Zotero & {
        DragDrop: { currentDragSource: unknown };
      }
    ).DragDrop;
    const onDragItems = (
      Zotero.Utilities.Internal as unknown as {
        onDragItems?: (event: DragEvent, ids: number[], image: Element) => void;
      }
    ).onDragItems;
    if (!source || !onDragItems || !event.currentTarget || !itemIDs.length) {
      throw new Error("Native Zotero item drag is unavailable");
    }
    dragDrop.currentDragSource = source;
    try {
      onDragItems(
        event,
        itemIDs,
        (event.target as Element).closest(".grid-view-item") ??
          (event.target as Element),
      );
    } catch (error) {
      dragDrop.currentDragSource = null;
      throw error;
    }
  }

  /** Delegate whitespace file drops to the same importer as Zotero's item tree. */
  canDropFiles(transfer: DataTransfer | null): boolean {
    if (!transfer || !this.itemsView.onDrop || !this.itemsView.canDropCheck)
      return false;
    const rows = this.itemsView.collectionTreeRows;
    if (!rows?.length || rows.some((row) => !row.ref)) return false;
    const libraries = new Set(rows.map((row) => row.ref.libraryID));
    if (libraries.size !== 1) return false;
    const libraryID = rows[0].ref.libraryID;
    const library = Zotero.Libraries.get(libraryID);
    if (!library || !library.editable) return false;
    if (!rows.every((row) => row.isCollection() || row.isLibrary(true)))
      return false;
    // Native onDrop imports each entry by its .path. Do not pass it URLs,
    // directories, mixed flavors, or entries whose type we cannot verify.
    if (
      !transfer.types?.includes("application/x-moz-file") ||
      transfer.types.some(
        (type) => type !== "application/x-moz-file" && type !== "Files",
      ) ||
      !transfer.mozItemCount ||
      !transfer.mozGetDataAt
    )
      return false;
    try {
      for (let index = 0; index < transfer.mozItemCount; index++) {
        const file = transfer.mozGetDataAt("application/x-moz-file", index) as {
          path?: string;
          isFile?: () => boolean;
        } | null;
        if (!file?.path || !file.isFile?.()) return false;
      }
      return this.itemsView.canDropCheck(-1, -1, transfer);
    } catch {
      return false;
    }
  }

  async dropFiles(event: DragEvent): Promise<void> {
    if (!this.canDropFiles(event.dataTransfer)) return;
    const dragDrop = Zotero as typeof Zotero & {
      DragDrop: {
        currentOrientation: number;
        currentDropEffect: string | null;
      };
    };
    // onDrop(-1) explicitly means whitespace; its internal row=0 is not a
    // tile target. Clear state left by another drop target before handing off.
    dragDrop.DragDrop.currentOrientation = -1;
    dragDrop.DragDrop.currentDropEffect = null;
    await this.itemsView.onDrop!(event, -1);
  }

  focus(): void {
    this.win.document
      .getElementById("zotero-items-tree")
      ?.querySelector<HTMLElement>("[role=tree]")
      ?.focus();
  }

  async selectItem(itemID: number): Promise<void> {
    await this.itemsView.selectItem(itemID);
  }

  async selectItems(itemIDs: number[]): Promise<void> {
    if (!itemIDs.length) {
      this.itemsView.selection.clearSelection();
      return;
    }
    await this.win.ZoteroPane.selectItems(itemIDs);
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

  /** Build Zotero's native item menu, then let Gecko flip it before display. */
  async openSelectedItemsMenu(anchor: HTMLElement): Promise<void> {
    const rect = anchor.getBoundingClientRect();
    const viewport = anchor.parentElement?.getBoundingClientRect() ?? rect;
    // This rectangle is the visible portion of the tile. Gecko positions a
    // short menu below it and flips a long menu above it in one paint.
    const right = Math.min(rect.right, viewport.right);
    const top = Math.max(rect.top, viewport.top);
    const bottom = Math.min(rect.bottom, viewport.bottom);
    await this.openItemMenu(
      Math.round(this.win.mozInnerScreenX + right),
      Math.round(this.win.mozInnerScreenY + top),
      Math.round(bottom - top),
    );
  }

  /** Open the native menu at the pointer without targeting the hidden tree. */
  async openSelectedItemsMenuAtScreen(x: number, y: number): Promise<void> {
    await this.openItemMenu(x, y, 0);
  }

  private async openItemMenu(
    x: number,
    y: number,
    height: number,
  ): Promise<void> {
    const pane = this.win.ZoteroPane as typeof this.win.ZoteroPane & {
      buildItemContextMenu?: () => Promise<void>;
    };
    const popup = this.win.document.getElementById(
      "zotero-itemmenu",
    ) as XULPopupElement | null;
    if (
      typeof pane.buildItemContextMenu !== "function" ||
      !popup?.openPopupAtScreenRect
    ) {
      throw new Error("Zotero item context menu opener is unavailable");
    }
    await pane.buildItemContextMenu();
    popup.openPopupAtScreenRect("after_start", x, y, 0, height, true);
  }

  /** Call after showing the native tree, when DOM measurements are available. */
  refreshLayout(): void {
    // Hidden selection/scroll updates can leave the windowed list's cached
    // scroll offset out of step with the DOM. update() reads the actual offset;
    // invalidate() then rebuilds the visible rows and updates column widths.
    this.itemsView._treebox?.update();
    this.itemsView.tree?.invalidate();
  }

  refreshRows(): void {
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
