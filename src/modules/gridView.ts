import {
  GridNavigationCommand,
  GridItemCommand,
  GridItemCommandOptions,
  GridRenderer,
  GridSelectionModifiers,
} from "./gridRenderer";
import { GridWindowUI } from "./gridWindowUI";
import { ItemTreeBridge } from "./itemTreeBridge";
import { CoverProvider } from "./coverProvider";
import { getPref, observePrefs, setPref } from "../utils/prefs";

const gridViews = new Map<Window, GridView>();
const GRID_RENDER_PREFS = [
  "showCreators",
  "showTitles",
  "showYears",
  "showItemTypeIcon",
  "desaturateOnlineCovers",
  "fetchISBNCover",
  "fetchMetadataCover",
] as const;
const WHEEL_PIXELS_PER_NOTCH = 100;
const WHEEL_LINES_PER_NOTCH = 3;
const TILE_SIZE_STEP = 9; // 5% of the 180px baseline
const MIN_TILE_SIZE = 90;
const MAX_TILE_SIZE = 360;
let stopObservingPreferences: (() => void) | undefined;

export class GridView {
  private readonly tree: ItemTreeBridge;
  private readonly ui: GridWindowUI;
  private readonly renderer: GridRenderer;
  private readonly presentationObserverID: string;
  private readonly stopCoverChanges: () => void;
  private readonly pendingCoverIDs = new Set<number>();
  private syncTimer?: number;
  private focusFrame?: number;
  private readonly selectionTimer: number;
  private itemIDs: number[] = [];
  private focusedItemID?: number;
  private selectionAnchorID?: number;
  private selectedIDs: number[] = [];
  private intendedSelection: number[] = [];
  private pendingSelections = 0;
  private selectionGeneration = 0;
  private selectionWrites: Promise<void> = Promise.resolve();
  private focusOwner?: "grid" | "tree";
  private wheelRemainder = 0;

  constructor(private readonly win: _ZoteroTypes.MainWindow) {
    this.tree = new ItemTreeBridge(win);
    this.ui = new GridWindowUI(win, this.toggleEnabled);
    this.renderer = new GridRenderer(
      this.ui.host,
      this.selectClickedItem,
      this.activateClickedItem,
      this.navigate,
      this.onGridFocus,
      this.handleItemCommand,
      this.openClickedItemMenu,
      this.startItemDrag,
    );
    this.applyTileSizePreference();
    this.ui.host.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
    this.ui.host.addEventListener("dragover", this.handleDragOver);
    this.ui.host.addEventListener("drop", this.handleDrop);
    this.ui.host.addEventListener("dragleave", this.handleDragLeave);
    this.ui.host.addEventListener("scroll", this.clearDropTile);
    this.win.document.addEventListener("dragend", this.clearDropTile);
    this.tree.onItemsChanged(this.scheduleSync);
    this.stopCoverChanges = CoverProvider.onCoverChanged((itemID) => {
      this.tree.refreshRows();
      if (this.win.Zotero_Tabs.selectedType !== "library") {
        this.pendingCoverIDs.add(itemID);
      } else if (getPref("enableGridView")) {
        this.renderer.refreshCover(itemID);
      }
    });
    // Programmatic native selection changes do not emit row-provider updates.
    this.selectionTimer = win.setInterval(() => {
      if (!getPref("enableGridView") || this.pendingSelections) return;
      const selected = this.tree.getSelectedIDs();
      if (
        selected.length !== this.selectedIDs.length ||
        selected.some((id) => !this.selectedIDs.includes(id))
      ) {
        this.scheduleSync();
      }
    }, 150);
    win.document.addEventListener("focusin", this.trackFocus);
    this.presentationObserverID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (
            type === "item-tag" ||
            (type === "setting" &&
              ids.some((id) => String(id).endsWith("/tagColors")))
          ) {
            this.scheduleSync();
          }
          if (
            type === "tab" &&
            event === "select" &&
            ids.some((id) => id === "zotero-pane")
          ) {
            for (const itemID of this.pendingCoverIDs) {
              if (getPref("enableGridView")) this.renderer.refreshCover(itemID);
            }
            this.pendingCoverIDs.clear();
            this.renderer.refreshLayout();
            this.scheduleSync();
          }
        },
      },
      ["tab", "item-tag", "setting"],
      "cover-view-grid",
    );
    this.applyEnabledPreference();
  }

  applyEnabledPreference(): void {
    this.clearDropTile();
    const enabled = !!getPref("enableGridView");
    const active = this.win.document.activeElement;
    const outgoingOwner = this.ui.ownsGridFocus(active)
      ? "grid"
      : this.ui.ownsTreeFocus(active)
        ? "tree"
        : this.focusOwner;
    const enteringGrid = enabled && !!this.ui.host.hidden;
    this.cancelSync();
    if (this.focusFrame !== undefined) {
      this.win.cancelAnimationFrame(this.focusFrame);
      this.focusFrame = undefined;
    }
    this.ui.setEnabled(enabled);
    if (!enabled) this.wheelRemainder = 0;
    if (!enabled) this.tree.refreshLayout();
    this.syncItems(enteringGrid);
    if (outgoingOwner === (enabled ? "tree" : "grid")) {
      if (enabled) this.ui.host.focus();
      else {
        // Zotero's virtualized tree is not focusable until its newly shown
        // layout has completed after the preference observer runs.
        const currentFocus = this.win.document.activeElement;
        this.focusFrame = this.win.requestAnimationFrame(() => {
          this.focusFrame = undefined;
          if (
            !getPref("enableGridView") &&
            this.win.document.activeElement === currentFocus
          ) {
            this.tree.focus();
            if (this.ui.ownsTreeFocus(this.win.document.activeElement)) {
              this.focusOwner = "tree";
            }
          }
        });
      }
    }
  }

  readonly toggleEnabled = (): void => {
    setPref("enableGridView", !getPref("enableGridView"));
  };

  applyTileSizePreference(): void {
    const size = getPref("tileSize");
    this.renderer.refreshLayout(() => {
      this.ui.host.style.setProperty(
        "--cover-view-tile-size",
        `${Number.isFinite(size) ? Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, size)) : 180}px`,
      );
    });
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    const isMacOS = this.win.navigator.platform.startsWith("Mac");
    if (
      this.ui.host.hidden ||
      event.altKey ||
      event.shiftKey ||
      (isMacOS
        ? !event.metaKey || event.ctrlKey
        : !event.ctrlKey || event.metaKey)
    )
      return;

    event.preventDefault();
    const delta =
      event.deltaMode === 1 // DOM_DELTA_LINE
        ? event.deltaY / WHEEL_LINES_PER_NOTCH
        : event.deltaMode === 2 // DOM_DELTA_PAGE
          ? event.deltaY
          : event.deltaY / WHEEL_PIXELS_PER_NOTCH;
    if (!Number.isFinite(delta)) return;
    const current = getPref("tileSize");
    if (
      (current <= MIN_TILE_SIZE && delta > 0) ||
      (current >= MAX_TILE_SIZE && delta < 0)
    ) {
      this.wheelRemainder = 0;
      return;
    }
    this.wheelRemainder += delta;
    const notches = Math.trunc(this.wheelRemainder);
    if (!notches) return;
    this.wheelRemainder -= notches;

    const size = Math.max(
      MIN_TILE_SIZE,
      Math.min(MAX_TILE_SIZE, current - notches * TILE_SIZE_STEP),
    );
    if (size !== current) setPref("tileSize", size);
    if (size === MIN_TILE_SIZE || size === MAX_TILE_SIZE) {
      this.wheelRemainder = 0;
    }
  };

  destroy(): void {
    if (this.focusFrame !== undefined)
      this.win.cancelAnimationFrame(this.focusFrame);
    this.win.clearInterval(this.selectionTimer);
    this.win.document.removeEventListener("focusin", this.trackFocus);
    this.ui.host.removeEventListener("wheel", this.handleWheel);
    this.ui.host.removeEventListener("dragover", this.handleDragOver);
    this.ui.host.removeEventListener("drop", this.handleDrop);
    this.ui.host.removeEventListener("dragleave", this.handleDragLeave);
    this.ui.host.removeEventListener("scroll", this.clearDropTile);
    this.win.document.removeEventListener("dragend", this.clearDropTile);
    this.clearDropTile();
    this.cancelSync();
    this.tree.destroy();
    this.stopCoverChanges();
    Zotero.Notifier.unregisterObserver(this.presentationObserverID);

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

  refreshCovers(): void {
    // The Cover column can be visible independently of the grid in this window.
    // Redraw it even when the grid is active so both presentations pick up the
    // newly selected lookup sources without requiring a view switch.
    this.tree.refreshRows();
    if (getPref("enableGridView")) this.scheduleSync();
  }

  private cancelSync(): void {
    if (this.syncTimer !== undefined) {
      this.win.clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  private transitionSelection(
    itemID: number,
    modifiers: GridSelectionModifiers,
    action: "click" | "navigate" | "toggle",
  ): void {
    if (!this.pendingSelections) {
      this.intendedSelection = this.tree.getSelectedIDs();
    }
    const anchorID = this.getSelectionAnchor();
    this.focusedItemID = itemID;
    this.renderer.setFocusedItem(itemID, action === "navigate");

    if (action === "toggle") {
      this.intendedSelection = this.toggleSelection(itemID);
    } else if (modifiers.shift) {
      const range = this.getRange(anchorID, itemID);
      this.intendedSelection = modifiers.primary
        ? this.addToSelection(range)
        : range;
    } else if (modifiers.primary && action === "navigate") {
      this.selectionAnchorID = itemID;
      return;
    } else {
      this.selectionAnchorID = itemID;
      this.intendedSelection = modifiers.primary
        ? this.toggleSelection(itemID)
        : [itemID];
    }

    this.writeSelection(itemID);
  }

  private writeSelection(itemID?: number): void {
    const selection = [...this.intendedSelection];
    const generation = this.selectionGeneration;
    this.pendingSelections++;
    this.selectionWrites = this.selectionWrites.then(async () => {
      try {
        // A failed write invalidates all intents based on its expected result.
        if (generation === this.selectionGeneration) {
          await this.tree.selectItems(selection);
        }
      } catch (error) {
        this.selectionGeneration++;
        this.selectionAnchorID = this.focusedItemID;
        ztoolkit.log("Failed to select grid item", itemID, error);
      } finally {
        this.selectedIDs = this.tree.getSelectedIDs();
        this.pendingSelections--;
        if (
          !this.pendingSelections ||
          generation !== this.selectionGeneration
        ) {
          this.intendedSelection = [...this.selectedIDs];
        }
        if (getPref("enableGridView")) {
          this.renderer.setSelection(this.selectedIDs);
        }
      }
    });
  }

  private readonly selectClickedItem = (
    itemID: number,
    modifiers: GridSelectionModifiers,
  ): void => {
    this.transitionSelection(itemID, modifiers, "click");
  };

  private readonly startItemDrag = (itemID: number, event: DragEvent): void => {
    try {
      // Read the native selection at drag start. An unselected tile is dragged
      // alone without changing selection or queuing an asynchronous tree write.
      const selected = this.tree.getSelectedIDs();
      const selectedSet = new Set(
        selected.includes(itemID) ? selected : [itemID],
      );
      const itemIDs = this.itemIDs.filter((id) => selectedSet.has(id));
      if (!itemIDs.length) {
        event.preventDefault();
        return;
      }
      this.tree.startItemDrag(event, itemIDs);
    } catch (error) {
      event.preventDefault();
      ztoolkit.log("Failed to start grid item drag", itemID, error);
    }
  };

  private isGridDrop(event: DragEvent): boolean {
    const target = event.target as Element | null;
    return (
      !this.ui.host.hidden &&
      this.win.Zotero_Tabs.selectedType === "library" &&
      !!target &&
      this.ui.host.contains(target)
    );
  }

  private readonly handleDragOver = (event: DragEvent): void => {
    this.clearDropTile();
    if (!this.isGridDrop(event)) return;
    const tile = (event.target as Element).closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    const itemID = tile ? Number(tile.dataset.itemId) : undefined;
    const hoverItems =
      tile && this.tree.canDropItems(event.dataTransfer, itemID!);
    const hoverFiles = this.tree.canHoverFiles(event.dataTransfer, itemID);
    if (tile && (hoverItems || hoverFiles)) {
      tile.classList.add("drop-target");
    }
    if (!hoverItems && !hoverFiles) {
      // Cancel even rejected hover events so Gecko applies the prohibit effect.
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const transfer = event.dataTransfer!;
    if (hoverItems) {
      this.tree.setItemDropEffect(event);
    } else if (this.win.navigator.platform.startsWith("Mac")) {
      // Gecko doesn't expose Mac modifiers during dragover; onDrop resolves them.
      transfer.dropEffect = "move";
    } else {
      transfer.dropEffect = event.shiftKey
        ? event.ctrlKey
          ? "link"
          : "move"
        : "copy";
    }
  };

  private readonly handleDrop = (event: DragEvent): void => {
    this.clearDropTile();
    if (!this.isGridDrop(event)) return;
    const tile = (event.target as Element).closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    const itemID = tile ? Number(tile.dataset.itemId) : undefined;
    if (event.dataTransfer?.types?.includes("zotero/item")) {
      if (!tile || !this.tree.canDropItems(event.dataTransfer, itemID!)) return;
      event.preventDefault();
      event.stopPropagation();
      void this.tree.dropItems(event, itemID!).catch((error) => {
        ztoolkit.log("Failed to reparent items in grid", error);
      });
      return;
    }
    if (tile && !this.tree.canDropFiles(event.dataTransfer, itemID)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.tree.dropFiles(event, itemID).catch((error) => {
      ztoolkit.log("Failed to import files into grid", error);
    });
  };

  private readonly clearDropTile = (): void => {
    for (const tile of this.ui.host.querySelectorAll(".drop-target"))
      tile.classList.remove("drop-target");
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && this.ui.host.querySelector(".drop-target")?.contains(next))
      return;
    this.clearDropTile();
  };

  private readonly openClickedItemMenu = (
    itemID: number,
    screenX: number,
    screenY: number,
  ): void => {
    if (!this.pendingSelections) {
      this.intendedSelection = this.tree.getSelectedIDs();
    }
    this.focusedItemID = itemID;
    this.selectionAnchorID = itemID;
    this.renderer.setFocusedItem(itemID);
    if (!this.intendedSelection.includes(itemID)) {
      this.intendedSelection = [itemID];
      this.writeSelection(itemID);
    }
    this.runSelectedItemCommand(async () => {
      if (this.tree.getSelectedIDs().includes(itemID)) {
        await this.tree.openSelectedItemsMenuAtScreen(screenX, screenY);
      }
    }, "Failed to open selected grid items menu");
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
    if (!this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      this.selectionAnchorID = this.focusedItemID;
    }
  };

  private readonly onGridFocus = (): void => {
    // Catch native selection changes before the periodic check runs when a
    // user moves keyboard focus into the grid.
    this.syncItems();
  };

  private readonly trackFocus = (event: FocusEvent): void => {
    const target = event.target as Element | null;
    if (this.ui.ownsGridFocus(target)) this.focusOwner = "grid";
    else if (this.ui.ownsTreeFocus(target)) this.focusOwner = "tree";
    else if (!this.ui.isToggle(target)) this.focusOwner = undefined;
  };

  private readonly activateClickedItem = (itemID: number): void => {
    void this.tree.activateItem(itemID).catch((error) => {
      ztoolkit.log("Failed to activate grid item", itemID, error);
      this.resynchronizeSelection();
    });
  };

  private readonly handleItemCommand = (
    command: GridItemCommand,
    options: GridItemCommandOptions,
  ): void => {
    switch (command) {
      case "toggle-tag":
        if (options.tagNumber === undefined) return;
        this.runSelectedItemCommand(
          () => this.tree.toggleSelectedItemsTag(options.tagNumber!),
          "Failed to toggle coloured tag on selected grid items",
        );
        return;
      case "activate":
        this.runSelectedItemCommand(
          () => this.tree.activateSelectedItems(),
          "Failed to activate selected grid items",
        );
        return;
      case "toggle-selection":
        this.ensureGridFocus();
        if (this.focusedItemID === undefined) return;
        this.transitionSelection(
          this.focusedItemID,
          { primary: false, shift: false },
          "toggle",
        );
        return;
      case "select-all":
        if (
          !this.itemIDs.length &&
          !this.pendingSelections &&
          !this.tree.getSelectedIDs().length
        )
          return;
        this.intendedSelection = [...this.itemIDs];
        this.writeSelection();
        return;
      case "delete":
        this.runSelectedItemCommand(
          () => this.tree.deleteSelectedItems(options.forceDelete ?? false),
          "Failed to delete selected grid items",
        );
        return;
      case "context-menu":
        this.runSelectedItemCommand(async () => {
          const selected = this.tree.getSelectedIDs();
          if (!selected.length) return;
          const anchor = this.renderer.ensureVisibleMenuAnchor(selected);
          if (anchor) await this.tree.openSelectedItemsMenu(anchor);
        }, "Failed to open selected grid items menu");
        return;
    }
  };

  private runSelectedItemCommand(
    action: () => Promise<void>,
    errorMessage: string,
  ): void {
    const generation = this.selectionGeneration;
    const expectedSelection = this.pendingSelections
      ? [...this.intendedSelection]
      : undefined;
    const run = async () => {
      if (generation !== this.selectionGeneration) return;
      if (expectedSelection) {
        const selected = this.tree.getSelectedIDs();
        if (
          selected.length !== expectedSelection.length ||
          expectedSelection.some((id) => !selected.includes(id))
        )
          return;
      }
      try {
        await action();
      } catch (error) {
        ztoolkit.log(errorMessage, error);
        this.resynchronizeSelection();
      }
    };
    if (this.pendingSelections) {
      this.selectionWrites = this.selectionWrites.then(run);
    } else {
      void run();
    }
  }

  private readonly navigate = (
    command: GridNavigationCommand,
    modifiers: GridSelectionModifiers,
  ): void => {
    this.ensureGridFocus();
    if (this.focusedItemID === undefined) return;

    const currentIndex = this.itemIDs.indexOf(this.focusedItemID);
    let destinationID: number | undefined;
    switch (command) {
      case "left":
        destinationID = this.itemIDs[currentIndex - 1];
        break;
      case "right":
        destinationID = this.itemIDs[currentIndex + 1];
        break;
      case "up":
      case "down":
        destinationID = this.renderer.getVerticalDestination(
          this.focusedItemID,
          command === "up" ? -1 : 1,
        );
        break;
      case "page-up":
      case "page-down":
        destinationID = this.renderer.getPageDestination(
          this.focusedItemID,
          command === "page-up" ? -1 : 1,
        );
        break;
      case "home":
        destinationID = this.itemIDs[0];
        break;
      case "end":
        destinationID = this.itemIDs.at(-1);
        break;
    }
    if (destinationID === undefined || destinationID === this.focusedItemID)
      return;

    this.transitionSelection(destinationID, modifiers, "navigate");
  };

  private getSelectionAnchor(): number {
    if (this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      return this.selectionAnchorID!;
    }
    this.selectionAnchorID = this.focusedItemID!;
    return this.selectionAnchorID;
  }

  private getRange(startID: number, endID: number): number[] {
    const start = this.itemIDs.indexOf(startID);
    const end = this.itemIDs.indexOf(endID);
    return this.itemIDs.slice(Math.min(start, end), Math.max(start, end) + 1);
  }

  private addToSelection(itemIDs: number[]): number[] {
    return [...new Set([...this.intendedSelection, ...itemIDs])];
  }

  private toggleSelection(itemID: number): number[] {
    const selectedIDs = new Set(this.intendedSelection);
    if (selectedIDs.has(itemID)) selectedIDs.delete(itemID);
    else selectedIDs.add(itemID);
    return [...selectedIDs];
  }

  private resynchronizeSelection(): void {
    this.selectedIDs = this.tree.getSelectedIDs();
    if (!this.pendingSelections) this.intendedSelection = [...this.selectedIDs];
    if (getPref("enableGridView")) {
      this.renderer.setSelection(this.selectedIDs);
    }
  }

  private syncItems(preserveFocusOnEntry = false): void {
    if (!getPref("enableGridView")) return;
    if (this.win.Zotero_Tabs.selectedType !== "library") return;
    const items = this.tree.getItems();
    const previousIDs = this.itemIDs;
    this.itemIDs = items.map((item) => item.id);
    const selectedIDs = this.tree.getSelectedIDs();
    const selectionChanged =
      selectedIDs.length !== this.selectedIDs.length ||
      selectedIDs.some((id) => !this.selectedIDs.includes(id));
    const additions = selectedIDs.filter(
      (id) => !this.selectedIDs.includes(id),
    );
    this.selectedIDs = selectedIDs;
    if (!this.pendingSelections) this.intendedSelection = [...selectedIDs];

    if (
      preserveFocusOnEntry &&
      !this.itemIDs.includes(this.focusedItemID ?? NaN)
    ) {
      const selected = new Set(selectedIDs);
      this.focusedItemID =
        this.itemIDs.findLast((id) => selected.has(id)) ?? this.itemIDs[0];
    } else if (!this.itemIDs.includes(this.focusedItemID ?? NaN)) {
      const oldIndex = previousIDs.indexOf(this.focusedItemID ?? NaN);
      this.focusedItemID =
        oldIndex < 0
          ? undefined
          : (previousIDs
              .slice(0, oldIndex)
              .reverse()
              .find((id) => this.itemIDs.includes(id)) ?? this.itemIDs[0]);
    } else if (
      !preserveFocusOnEntry &&
      !this.pendingSelections &&
      selectionChanged &&
      selectedIDs.length
    ) {
      this.focusedItemID =
        (additions.length === 1 && this.itemIDs.includes(additions[0])
          ? additions[0]
          : undefined) ??
        this.itemIDs.findLast((id) => selectedIDs.includes(id)) ??
        this.focusedItemID;
    }
    if (!this.itemIDs.includes(this.selectionAnchorID ?? NaN)) {
      this.selectionAnchorID = this.focusedItemID;
    }
    this.renderer.setItems(items, {
      showCreators: getPref("showCreators"),
      showTitles: getPref("showTitles"),
      showYears: getPref("showYears"),
      showItemTypeIcon: getPref("showItemTypeIcon"),
      desaturateOnlineCovers: getPref("desaturateOnlineCovers"),
    });
    this.renderer.setSelection(selectedIDs);
    if (!this.itemIDs.length) {
      this.focusedItemID = undefined;
      this.selectionAnchorID = undefined;
      this.renderer.setFocusedItem(undefined);
    } else if (this.ui.ownsGridFocus(this.win.document.activeElement)) {
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
    for (const gridView of gridViews.values()) gridView.refreshCovers();
  });
  const stopSizeObserver = observePrefs(["tileSize"], () => {
    for (const gridView of gridViews.values())
      gridView.applyTileSizePreference();
  });
  stopObservingPreferences = () => {
    stopEnabledObserver();
    stopRenderObserver();
    stopSizeObserver();
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
