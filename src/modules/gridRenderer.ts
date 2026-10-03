import { CoverProvider } from "./coverProvider";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";

const CHUNK_SIZE = 120;

export type GridNavigationCommand =
  "left" | "right" | "up" | "down" | "home" | "end" | "page-up" | "page-down";

export type GridItemCommand =
  "activate" | "toggle-selection" | "select-all" | "delete" | "context-menu";

export interface GridItemCommandOptions {
  forceDelete?: boolean;
}

export interface GridSelectionModifiers {
  primary: boolean;
  shift: boolean;
}

export interface GridRenderOptions {
  showCreators: boolean;
  showTitles?: boolean;
  showYears?: boolean;
}

interface GridRenderItem {
  item: Zotero.Item;
  title: string;
  creators: string;
  captionTitle: string;
  year: string;
}

export class GridRenderer {
  private readonly doc: Document;
  private renderVersion = 0;
  private renderKey?: string;
  private renderItems: GridRenderItem[] = [];
  private renderedCount = 0;
  private readonly chunkObserver: IntersectionObserver;
  private readonly coverObserver: IntersectionObserver;
  private readonly entries = new Map<number, HTMLElement>();
  private selectedIDs = new Set<number>();
  private focusedItemID?: number;

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (
      itemID: number,
      modifiers: GridSelectionModifiers,
    ) => void,
    private readonly onActivate?: (itemID: number) => void,
    private readonly onNavigate?: (
      command: GridNavigationCommand,
      modifiers: GridSelectionModifiers,
    ) => void,
    private readonly onFocus?: () => void,
    private readonly onItemCommand?: (
      command: GridItemCommand,
      options: GridItemCommandOptions,
    ) => void,
    private readonly onContextMenu?: (
      itemID: number,
      screenX: number,
      screenY: number,
    ) => void,
    private readonly onDragStart?: (itemID: number, event: DragEvent) => void,
  ) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
    this.host.tabIndex = 0;
    this.host.setAttribute("role", "listbox");
    this.host.setAttribute("aria-multiselectable", "true");
    this.host.addEventListener("click", this.handleClick);
    this.host.addEventListener("dblclick", this.handleDoubleClick);
    this.host.addEventListener("contextmenu", this.handleContextMenu);
    this.host.addEventListener("dragstart", this.handleDragStart);
    this.host.addEventListener("keydown", this.handleKeyDown);
    this.host.addEventListener("focus", this.handleFocus);
    this.host.addEventListener("blur", this.handleBlur);
    doc.addEventListener("focus", this.handleDocumentFocus, true);
    doc.defaultView!.addEventListener("blur", this.handleWindowBlur);
    doc.defaultView!.addEventListener("focus", this.handleWindowFocus);
    this.chunkObserver = new doc.defaultView!.IntersectionObserver(
      (entries: IntersectionObserverEntry[]) => {
        const sentinel = this.host.querySelector(".grid-view-sentinel");
        if (
          sentinel &&
          entries.some(
            (entry) => entry.isIntersecting && entry.target === sentinel,
          )
        ) {
          this.renderChunk();
        }
      },
      { root: this.host, rootMargin: "400px" },
    );
    this.coverObserver = new doc.defaultView!.IntersectionObserver(
      (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !this.host.contains(entry.target))
            continue;
          this.coverObserver.unobserve(entry.target);
          void this.loadCover(entry.target as HTMLElement);
        }
      },
      { root: this.host, rootMargin: "200px" },
    );
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const itemID = this.getEventItemID(event);
    if (itemID !== undefined) {
      this.host.focus();
      this.onSelect(itemID, this.getSelectionModifiers(event));
    }
  };

  private readonly handleDoubleClick = (event: Event): void => {
    const itemID = this.getEventItemID(event);
    if (itemID !== undefined) this.onActivate?.(itemID);
  };

  private getEventItemID(event: Event): number | undefined {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return undefined;

    const itemID = Number(entry.dataset.itemId);
    return Number.isSafeInteger(itemID) ? itemID : undefined;
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    const itemID = this.getEventItemID(event);
    if (itemID === undefined) return;
    event.preventDefault();
    this.host.focus();
    this.onContextMenu?.(itemID, event.screenX, event.screenY);
  };

  private readonly handleDragStart = (event: DragEvent): void => {
    const itemID = this.getEventItemID(event);
    if (itemID === undefined || !event.dataTransfer || !this.onDragStart) {
      event.preventDefault();
      return;
    }
    this.onDragStart(itemID, event);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const modifiers = this.getSelectionModifiers(event);
    // Zotero uses both Ctrl and Cmd page shortcuts to change tabs. Leave
    // these combinations (including Shift) to the application.
    if (
      (event.key === "PageUp" || event.key === "PageDown") &&
      (event.ctrlKey || event.metaKey)
    )
      return;
    if (
      event.altKey ||
      (event.ctrlKey && this.isMacOS()) ||
      (event.metaKey && !this.isMacOS())
    )
      return;
    const navigationCommand = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      Home: "home",
      End: "end",
      PageUp: "page-up",
      PageDown: "page-down",
    }[event.key] as GridNavigationCommand | undefined;
    if (navigationCommand) {
      event.preventDefault();
      this.onNavigate?.(navigationCommand, modifiers);
      return;
    }

    const command = this.getItemCommand(event);
    if (!command) return;

    event.preventDefault();
    this.onItemCommand?.(command.command, command.options);
  };

  private getItemCommand(
    event: KeyboardEvent,
  ): { command: GridItemCommand; options: GridItemCommandOptions } | undefined {
    if (
      (event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)) &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      return { command: "context-menu", options: {} };
    }
    if (
      event.key.toLowerCase() === "a" &&
      (this.isMacOS() ? event.metaKey : event.ctrlKey) &&
      !event.shiftKey
    ) {
      return { command: "select-all", options: {} };
    }
    if (event.key === "Enter") return { command: "activate", options: {} };
    if (event.key === " " || event.key === "Spacebar") {
      return { command: "toggle-selection", options: {} };
    }
    if (event.key === "Delete") {
      return {
        command: "delete",
        options: {
          forceDelete: this.isMacOS() ? event.metaKey : event.shiftKey,
        },
      };
    }
    if (event.key === "Backspace" && this.isMacOS()) {
      return { command: "delete", options: { forceDelete: event.metaKey } };
    }
    return undefined;
  }

  private getSelectionModifiers(
    event: MouseEvent | KeyboardEvent,
  ): GridSelectionModifiers {
    return {
      primary: this.isMacOS() ? event.metaKey : event.ctrlKey,
      shift: event.shiftKey,
    };
  }

  private isMacOS(): boolean {
    return this.doc.defaultView!.navigator.platform.startsWith("Mac");
  }

  private readonly handleFocus = (): void => {
    this.host.classList.add("owns-focus");
    this.onFocus?.();
  };

  private readonly handleBlur = (): void => {
    this.host.classList.remove("owns-focus");
  };

  private readonly handleDocumentFocus = (event: FocusEvent): void => {
    if (event.target !== this.host) this.host.classList.remove("owns-focus");
  };

  private readonly handleWindowBlur = (): void => {
    this.host.classList.remove("owns-focus");
  };

  private readonly handleWindowFocus = (): void => {
    // Switching windows need not blur the document's active element.
    this.host.classList.toggle(
      "owns-focus",
      this.doc.activeElement === this.host,
    );
  };

  setItems(items: Zotero.Item[], options: GridRenderOptions): void {
    const scrollTop = this.host.scrollTop;
    const renderItems = items.map((item) => this.renderItem(item, options));
    const renderKey = this.makeRenderKey(renderItems);
    if (renderKey === this.renderKey) {
      for (const [index, rendered] of renderItems.entries()) {
        const previous = this.renderItems[index];
        if (
          rendered.captionTitle === previous.captionTitle &&
          rendered.creators === previous.creators &&
          rendered.year === previous.year
        )
          continue;
        const entry = this.entries.get(rendered.item.id);
        if (entry) {
          this.updateCaption(entry, rendered);
        }
      }
      this.renderItems = renderItems;
      return;
    }
    this.renderKey = renderKey;

    this.renderItems = renderItems;
    this.renderedCount = 0;
    ++this.renderVersion;
    this.chunkObserver.disconnect();
    this.coverObserver.disconnect();
    this.entries.clear();
    this.host.replaceChildren();
    this.renderChunk();
    this.updateActiveDescendant();
    this.host.scrollTop = scrollTop;
  }

  private makeRenderKey(items: GridRenderItem[]): string {
    return JSON.stringify([
      getPref("fetchISBNCover"),
      getPref("fetchMetadataCover"),
      items.map(({ item, title }) => [item.id, title]),
    ]);
  }

  private renderItem(
    item: Zotero.Item,
    options: GridRenderOptions,
  ): GridRenderItem {
    const title = item.getDisplayTitle();
    // Match the native Year column: normalized date, unknown-year suppression,
    // and no leading zeros for years before 1000.
    const rawYear =
      options.showYears === false
        ? ""
        : String(item.getField?.("date", true, true) || "").slice(0, 4);
    const year = rawYear && rawYear !== "0000" ? String(Number(rawYear)) : "";
    return {
      item,
      title,
      captionTitle: options.showTitles === false ? "" : title,
      creators: options.showCreators ? item.firstCreator : "",
      year,
    };
  }

  /** Replace only the edited tile; leave other covers and offscreen tiles alone. */
  refreshCover(itemID: number): void {
    const index = this.renderItems.findIndex(({ item }) => item.id === itemID);
    if (index < 0) return;
    const item = Zotero.Items.get(itemID);
    if (!item || Array.isArray(item)) return;
    this.renderItems[index] = this.renderItem(item, {
      showCreators: getPref("showCreators"),
      showTitles: getPref("showTitles"),
      showYears: getPref("showYears"),
    });
    this.renderKey = this.makeRenderKey(this.renderItems);
    const oldEntry = this.entries.get(itemID);
    if (!oldEntry) return;
    this.coverObserver.unobserve(oldEntry);
    const replacement = this.buildTile(this.renderItems[index], index);
    oldEntry.replaceWith(replacement);
    this.updateActiveDescendant();
  }

  private renderChunk(): void {
    const previousSentinel = this.host.querySelector(".grid-view-sentinel");
    if (previousSentinel) {
      this.chunkObserver.unobserve(previousSentinel);
      previousSentinel.remove();
    }

    const end = Math.min(
      this.renderedCount + CHUNK_SIZE,
      this.renderItems.length,
    );
    const fragment = this.doc.createDocumentFragment();

    for (let index = this.renderedCount; index < end; index++) {
      fragment.appendChild(this.buildTile(this.renderItems[index], index));
    }
    this.renderedCount = end;

    let sentinel: HTMLElement | undefined;
    if (this.renderedCount < this.renderItems.length) {
      sentinel = this.doc.createElement("div");
      sentinel.className = "grid-view-sentinel";
      sentinel.setAttribute("aria-hidden", "true");
      fragment.appendChild(sentinel);
    }

    this.host.appendChild(fragment);
    if (sentinel) this.chunkObserver.observe(sentinel);
  }

  private buildTile(
    rendered: GridRenderItem,
    renderIndex: number,
  ): HTMLElement {
    const { item, title } = rendered;
    const entry = this.doc.createElement("figure");
    entry.className = "grid-view-item";
    entry.dataset.itemId = String(item.id);
    entry.dataset.renderIndex = String(renderIndex);
    entry.classList.toggle("selected", this.selectedIDs.has(item.id));
    entry.classList.toggle("focused", this.focusedItemID === item.id);
    entry.id = `${this.host.id || "cover-view-grid"}-item-${item.id}`;
    entry.setAttribute("role", "option");
    entry.draggable = true;
    entry.setAttribute("aria-selected", String(this.selectedIDs.has(item.id)));
    this.entries.set(item.id, entry);

    const coverFrame = this.doc.createElement("div");
    coverFrame.className = "grid-view-cover";

    const image = this.doc.createElement("img");
    image.alt = getString("cover-view-image-alt", { args: { title } });
    image.hidden = true;
    // Native image dragging would bypass the tile's item payload.
    image.draggable = false;
    coverFrame.appendChild(image);

    entry.appendChild(coverFrame);
    this.updateCaption(entry, rendered);
    this.coverObserver.observe(entry);

    return entry;
  }

  private updateCaption(entry: HTMLElement, rendered: GridRenderItem): void {
    entry.setAttribute(
      "aria-label",
      [rendered.title, rendered.creators, rendered.year]
        .filter(Boolean)
        .join(" · "),
    );
    entry.querySelector("figcaption")?.remove();
    const caption = this.buildCaption(rendered);
    if (caption) entry.appendChild(caption);
  }

  private buildCaption({
    captionTitle,
    creators,
    year,
  }: GridRenderItem): HTMLElement | undefined {
    const caption = this.doc.createElement("figcaption");
    if (captionTitle) {
      const titleLine = this.doc.createElement("span");
      titleLine.className = "grid-view-title";
      titleLine.textContent = captionTitle;
      titleLine.title = captionTitle;
      caption.appendChild(titleLine);
    }

    if (creators || year) {
      const metadataLine = this.doc.createElement("span");
      metadataLine.className = "grid-view-metadata";
      metadataLine.title = [creators, year].filter(Boolean).join(" · ");
      if (creators) {
        const creator = this.doc.createElement("span");
        creator.className = "grid-view-creators";
        creator.textContent = creators;
        metadataLine.appendChild(creator);
      }
      if (creators && year) {
        const separator = this.doc.createElement("span");
        separator.className = "grid-view-separator";
        separator.textContent = " · ";
        metadataLine.appendChild(separator);
      }
      if (year) {
        const yearLine = this.doc.createElement("span");
        yearLine.className = "grid-view-year";
        yearLine.textContent = year;
        metadataLine.appendChild(yearLine);
      }
      caption.appendChild(metadataLine);
    }

    return caption.childElementCount ? caption : undefined;
  }

  private async loadCover(entry: HTMLElement): Promise<void> {
    const renderIndex = Number(entry.dataset.renderIndex);
    const item = Number.isSafeInteger(renderIndex)
      ? this.renderItems[renderIndex]?.item
      : undefined;
    if (!item) return;

    const renderVersion = this.renderVersion;
    CoverProvider.cacheCover(item);
    const cover = await CoverProvider.getCover(item.id);
    if (
      !cover ||
      renderVersion !== this.renderVersion ||
      !this.host.contains(entry)
    ) {
      return;
    }

    const image = entry.querySelector("img");
    if (!image) return;
    image.addEventListener(
      "load",
      () => {
        if (renderVersion === this.renderVersion && this.host.contains(entry)) {
          image.hidden = false;
        }
      },
      { once: true },
    );
    image.src = cover;
  }

  /** Update selection presentation without rebuilding tiles or reloading covers. */
  setSelection(itemIDs: readonly number[]): void {
    this.selectedIDs = new Set(itemIDs);
    for (const [itemID, entry] of this.entries) {
      const selected = this.selectedIDs.has(itemID);
      entry.classList.toggle("selected", selected);
      entry.setAttribute("aria-selected", String(selected));
    }
  }

  /** Present grid-owned focus independently from Zotero's selected items. */
  setFocusedItem(itemID: number | undefined, scroll = false): void {
    this.focusedItemID = itemID;
    if (itemID !== undefined) this.renderThroughItem(itemID);
    for (const [entryItemID, entry] of this.entries) {
      entry.classList.toggle("focused", entryItemID === itemID);
    }
    this.updateActiveDescendant();
    if (scroll && itemID !== undefined) {
      this.entries
        .get(itemID)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Choose the last selected tile in grid order that intersects the viewport. */
  ensureVisibleMenuAnchor(
    selectedIDs: readonly number[],
  ): HTMLElement | undefined {
    const selected = new Set(selectedIDs);
    const viewport = this.host.getBoundingClientRect();
    let visible: HTMLElement | undefined;
    for (const entry of this.entries.values()) {
      if (!selected.has(Number(entry.dataset.itemId))) continue;
      const rect = entry.getBoundingClientRect();
      if (
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom &&
        rect.right > viewport.left &&
        rect.left < viewport.right
      ) {
        visible = entry;
      }
    }
    if (visible) return visible;

    const last = this.renderItems.findLast(({ item }) => selected.has(item.id));
    if (!last) return undefined;
    this.renderThroughItem(last.item.id);
    const entry = this.entries.get(last.item.id);
    entry?.scrollIntoView({ block: "nearest", inline: "nearest" });
    return entry;
  }

  /** Find the item in the corresponding column of an adjacent rendered row. */
  getVerticalDestination(
    itemID: number,
    direction: -1 | 1,
  ): number | undefined {
    const current = this.entries.get(itemID);
    if (!current) return undefined;

    let rows = this.getRenderedRows();
    let rowIndex = rows.findIndex((row) => row.includes(current));
    const columnIndex = rows[rowIndex].indexOf(current);

    if (direction === 1 && this.renderedCount < this.renderItems.length) {
      let destinationRow = rows[rowIndex + direction];
      while (!destinationRow || columnIndex >= destinationRow.length) {
        this.renderChunk();
        rows = this.getRenderedRows();
        rowIndex = rows.findIndex((row) => row.includes(current));
        destinationRow = rows[rowIndex + direction];
        if (this.renderedCount >= this.renderItems.length) break;
      }
    }

    const destinationRow = rows[rowIndex + direction];
    if (!destinationRow) return undefined;

    const destination =
      destinationRow[Math.min(columnIndex, destinationRow.length - 1)];
    const destinationID = Number(destination.dataset.itemId);
    return Number.isSafeInteger(destinationID) ? destinationID : undefined;
  }

  /** Move about one viewport in the current visual column, using live rows. */
  getPageDestination(itemID: number, direction: -1 | 1): number | undefined {
    const current = this.entries.get(itemID);
    if (!current) return undefined;

    let rows = this.getRenderedRows();
    const rowIndex = rows.findIndex((row) => row.includes(current));
    const columnIndex = rows[rowIndex].indexOf(current);
    if (rows.length === 1 && this.renderedCount < this.renderItems.length) {
      this.renderChunk();
      rows = this.getRenderedRows();
    }
    const rowStep =
      rows.length > 1 ? rows[1][0].offsetTop - rows[0][0].offsetTop : 0;
    // Move to the furthest row that has entered this viewport, including a
    // partially visible row. Still advance a row in short viewports.
    const distance = Math.max(rowStep, this.host.clientHeight - 1);
    const viewport = this.host.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    const viewportEdge =
      current.offsetTop +
      (direction === 1
        ? viewport.bottom - currentRect.top - 1
        : viewport.top - currentRect.top);
    const targetTop =
      direction === 1
        ? Math.max(
            current.offsetTop + rowStep,
            Math.min(current.offsetTop + distance, viewportEdge),
          )
        : Math.min(
            current.offsetTop - rowStep,
            Math.max(current.offsetTop - distance, viewportEdge),
          );

    if (direction === 1) {
      while (
        this.renderedCount < this.renderItems.length &&
        rows.at(-1)![0].offsetTop < targetTop
      ) {
        this.renderChunk();
        rows = this.getRenderedRows();
      }
    }

    let destinationRowIndex = rowIndex;
    for (
      let index = rowIndex + direction;
      index >= 0 && index < rows.length;
      index += direction
    ) {
      destinationRowIndex = index;
      if (direction * (rows[index][0].offsetTop - targetTop) > 0) {
        const previous = index - direction;
        const rowRect = rows[index][0].getBoundingClientRect();
        const partiallyVisible =
          direction === 1
            ? rowRect.top < viewport.bottom
            : rowRect.bottom > viewport.top;
        if (previous !== rowIndex && !partiallyVisible) {
          destinationRowIndex = previous;
        }
        break;
      }
    }

    const row = rows[destinationRowIndex];
    const destination = row[Math.min(columnIndex, row.length - 1)];
    const destinationID = Number(destination.dataset.itemId);
    return Number.isSafeInteger(destinationID) ? destinationID : undefined;
  }

  private getRenderedRows(): HTMLElement[][] {
    const rows: HTMLElement[][] = [];
    for (const entry of this.entries.values()) {
      const row = rows.at(-1);
      if (!row || row[0].offsetTop !== entry.offsetTop) {
        rows.push([entry]);
      } else {
        row.push(entry);
      }
    }
    return rows;
  }

  private renderThroughItem(itemID: number): void {
    const itemIndex = this.renderItems.findIndex(
      ({ item }) => item.id === itemID,
    );
    while (itemIndex >= this.renderedCount) this.renderChunk();
  }

  private updateActiveDescendant(): void {
    const entry =
      this.focusedItemID === undefined
        ? undefined
        : this.entries.get(this.focusedItemID);
    if (entry) {
      this.host.setAttribute("aria-activedescendant", entry.id);
    } else {
      this.host.removeAttribute("aria-activedescendant");
    }
  }

  /** Refresh Gecko's scroll-frame layout after the grid becomes visible again. */
  refreshLayout(): void {
    const scrollTop = this.host.scrollTop;
    this.host.scrollTop = scrollTop > 0 ? scrollTop - 1 : 1;
    this.host.scrollTop = scrollTop;
  }

  destroy(): void {
    this.renderVersion++;
    this.renderKey = undefined;
    this.host.removeEventListener("click", this.handleClick);
    this.host.removeEventListener("dblclick", this.handleDoubleClick);
    this.host.removeEventListener("contextmenu", this.handleContextMenu);
    this.host.removeEventListener("dragstart", this.handleDragStart);
    this.host.removeEventListener("keydown", this.handleKeyDown);
    this.host.removeEventListener("focus", this.handleFocus);
    this.host.removeEventListener("blur", this.handleBlur);
    this.doc.removeEventListener("focus", this.handleDocumentFocus, true);
    this.doc.defaultView!.removeEventListener("blur", this.handleWindowBlur);
    this.doc.defaultView!.removeEventListener("focus", this.handleWindowFocus);
    this.chunkObserver.disconnect();
    this.coverObserver.disconnect();
    this.renderItems = [];
    this.renderedCount = 0;
    this.entries.clear();
    this.selectedIDs.clear();
    this.focusedItemID = undefined;
    this.host.replaceChildren();
  }
}
