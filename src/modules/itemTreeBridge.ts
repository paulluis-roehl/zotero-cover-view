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
  onDragOver?: (event: DragEvent, row: number) => void;
  setDropEffect?: (event: DragEvent, effect: string) => void;
};
type CollectionDropRow = {
  id?: string;
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
  private collectionGeneration = 0;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    const itemsView = win.ZoteroPane.itemsView as ItemsView | false;
    if (!itemsView) {
      throw new Error("Cannot attach grid view: itemsView is not available");
    }
    this.itemsView = itemsView;
    const collections = win.ZoteroPane.collectionsView as
      CollectionsView | false;
    if (collections && collections.onSelect) {
      const changed = () => {
        this.collectionGeneration++;
      };
      collections.onSelect.addListener(changed);
      this.removeListeners.add(() =>
        collections.onSelect!.removeListener(changed),
      );
    }
  }

  /** Snapshot both the displayed and requested collection contexts. */
  getDropContext(): string | undefined {
    const collections = this.win.ZoteroPane
      .collectionsView as CollectionsView & {
      getSelectedRows?: () => CollectionDropRow[];
    };
    const identity = (rows: CollectionDropRow[] = []) =>
      rows
        .map((row) => JSON.stringify([row.id, row.ref?.libraryID, row.ref?.id]))
        .sort();
    const displayed = identity(this.itemsView.collectionTreeRows);
    const requestedRows = collections?.getSelectedRows?.();
    const requested = requestedRows && identity(requestedRows);
    // During asynchronous collection loading the old item tree can still be
    // displayed. It must not receive even a newly started hover/drop.
    if (
      !displayed.length ||
      (requested && JSON.stringify(displayed) !== JSON.stringify(requested))
    )
      return undefined;
    return JSON.stringify([this.collectionGeneration, displayed, requested]);
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

  /** File flavors may be visible before Gecko exposes the actual files. */
  canHoverFiles(transfer: DataTransfer | null, itemID?: number): boolean {
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
    if (itemID !== undefined) {
      const item = this.getItems().find((item) => item.id === itemID);
      if (
        !item?.isRegularItem() ||
        item.deleted ||
        item.libraryID !== libraryID
      )
        return false;
      if (!library.filesEditable) return false;
    }
    // Gecko may not expose file objects during dragover; check flavors here
    // and defer file validation and Zotero's native check until the drop.
    try {
      return (
        !!transfer.types?.includes("application/x-moz-file") &&
        transfer.mozItemCount > 0 &&
        typeof transfer.mozGetDataAt === "function" &&
        !transfer.types.some(
          (type) =>
            type !== "application/x-moz-file" &&
            type !== "text/x-moz-url" &&
            type !== "Files",
        )
      );
    } catch {
      return false;
    }
  }

  canDropFiles(transfer: DataTransfer | null, itemID?: number): boolean {
    if (!transfer || !this.canHoverFiles(transfer, itemID)) return false;
    try {
      for (let index = 0; index < transfer.mozItemCount; index++) {
        const entry = transfer.mozGetDataAt(
          "application/x-moz-file",
          index,
        ) as {
          QueryInterface?: (iface: typeof Ci.nsIFile) => {
            path?: string;
            isFile?: () => boolean;
          };
          path?: string;
          isFile?: () => boolean;
        } | null;
        const file = entry?.QueryInterface?.(Ci.nsIFile) ?? entry;
        if (!file?.path || !file.isFile?.()) return false;
      }
      const row =
        itemID === undefined
          ? -1
          : this.itemsView.getRowIndexByID(String(itemID));
      return (
        row !== false &&
        !!this.itemsView.canDropCheck!(
          row,
          itemID === undefined ? -1 : 0,
          transfer,
        )
      );
    } catch {
      return false;
    }
  }

  /** Validate direct item drops using the native target row and restrictions. */
  canDropItems(transfer: DataTransfer | null, itemID: number): boolean {
    if (
      !transfer?.types?.includes("zotero/item") ||
      !this.itemsView.onDrop ||
      !this.itemsView.setDropEffect
    )
      return false;
    const item = this.getItems().find((item) => item.id === itemID);
    if (!item?.isRegularItem() || item.deleted) return false;
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library || !library.editable) return false;
    const rows = this.itemsView.collectionTreeRows;
    if (
      !rows?.length ||
      !rows.every(
        (row) =>
          row.ref?.libraryID === item.libraryID &&
          (row.isCollection() || row.isLibrary(true)),
      )
    )
      return false;
    const row = this.itemsView.getRowIndexByID(String(itemID));
    if (row === false) return false;
    try {
      return !!this.itemsView.canDropCheck?.(row, 0, transfer);
    } catch {
      return false;
    }
  }

  setItemDropEffect(event: DragEvent): void {
    // Native file drags may allow only copy at the OS level. Zotero's helper
    // negotiates a permitted cursor effect while recording the internal move.
    this.itemsView.setDropEffect!(event, "move");
  }

  async dropItems(event: DragEvent, itemID: number): Promise<void> {
    if (
      !this.itemsView.onDrop ||
      !this.canDropItems(event.dataTransfer, itemID)
    )
      return;
    const row = this.itemsView.getRowIndexByID(String(itemID));
    if (row === false) return;
    const { DragDrop } = Zotero as typeof Zotero & {
      DragDrop: {
        currentOrientation: number;
        currentDropEffect: string | null;
      };
    };
    // Ignore orientation/effect left by another view. A tile is always a
    // direct-on-parent move, never a between-row or whitespace drop.
    DragDrop.currentOrientation = 0;
    DragDrop.currentDropEffect = "move";
    await this.itemsView.onDrop(event, row);
  }

  async dropFiles(event: DragEvent, itemID?: number): Promise<void> {
    if (!this.canDropFiles(event.dataTransfer, itemID)) return;
    const row =
      itemID === undefined
        ? -1
        : this.itemsView.getRowIndexByID(String(itemID));
    if (row === false || !this.itemsView.onDragOver) return;
    // Native hover computes orientation from the event target's geometry.
    // Normalize to the tile center: every point on a tile means "on parent".
    // Do this at drop time, when Gecko exposes protected file data and modifiers.
    const target = event.currentTarget as Element;
    const rect = target.getBoundingClientRect();
    const hover = new this.win.DragEvent("dragover", {
      cancelable: true,
      clientY: rect.y + rect.height / 2,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
    Object.defineProperties(hover, {
      target: { value: target },
      currentTarget: { value: target },
      dataTransfer: { value: event.dataTransfer },
    });
    this.itemsView.onDragOver(hover, row);
    const dragDrop = Zotero as typeof Zotero & {
      DragDrop: {
        currentOrientation: number;
        currentDropEffect: string | null;
      };
    };
    // onDrop(-1) explicitly means whitespace; its internal row=0 is not a
    // tile target. Set orientation explicitly, independent of DOM geometry.
    dragDrop.DragDrop.currentOrientation = itemID === undefined ? -1 : 0;
    await this.itemsView.onDrop!(event, row);
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

  /** Forward only the native coloured-tag shortcut, preserving Zotero-version
   * specific mixed-selection toggling, transactions, and undo behavior. */
  async toggleSelectedItemsTag(number: number): Promise<void> {
    if (!Number.isInteger(number) || number < 0 || number > 9) return;
    const items = this.win.ZoteroPane.getSelectedItems();
    if (!items.length || items.some((item) => !item.isEditable())) return;
    const rows = this.itemsView.collectionTreeRows;
    if (rows && new Set(rows.map((row) => row.ref?.libraryID)).size > 1) return;
    const nativeView = this.itemsView as ItemsView & {
      handleKeyDown?: (event: KeyboardEvent) => boolean;
    };
    if (!nativeView.handleKeyDown) return;
    nativeView.handleKeyDown(
      new this.win.KeyboardEvent("keydown", {
        key: String(number),
        code: `Digit${number}`,
      }),
    );
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
    // Selection may have scrolled while display:none clamped the DOM offset
    // to zero. Once measurable, let Zotero reveal the selected native rows.
    this.itemsView.ensureRowsAreVisible(this.itemsView.selection.selected);
    // Native rowIsVisible() can include the overscan row below the viewport.
    // The focused row's scroll helper checks the actual row bounds instead.
    if (this.itemsView.selection.isSelected(this.itemsView.selection.focused)) {
      this.itemsView.ensureRowIsVisible(this.itemsView.selection.focused);
    }
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
