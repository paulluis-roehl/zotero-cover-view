import { CoverProvider } from "./coverProvider";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getItemYear } from "../utils/itemYear";
import { getTagIndicators, TagIndicator } from "./tagIndicators";
import { getPageRow, GridRowGeometry } from "./gridLayout";

// Mount intersecting rows within 400 CSS pixels of either viewport edge.
// Mounted bound: C * (ceil((viewportHeight + 800 + Hmax) / Smin) + 1)
// plus at most one focused tile and one active drag source. Hmax is the tallest
// row and Smin the smallest distance between row tops in the current layout.
// Focus retention ends when its identity changes/clears; drag retention ends on
// drop/dragend. Destruction releases both. Selection and menus never pin tiles.
const TILE_OVERSCAN = 400;

export type GridNavigationCommand =
  "left" | "right" | "up" | "down" | "home" | "end" | "page-up" | "page-down";

export type GridItemCommand =
  | "activate"
  | "toggle-selection"
  | "select-all"
  | "delete"
  | "context-menu"
  | "toggle-tag";

export interface GridItemCommandOptions {
  forceDelete?: boolean;
  tagNumber?: number;
}

export interface GridSelectionModifiers {
  primary: boolean;
  shift: boolean;
}

export interface GridRenderOptions {
  showCreators: boolean;
  showTitles?: boolean;
  showYears?: boolean;
  showItemTypeIcon?: boolean;
  desaturateOnlineCovers?: boolean;
}

interface GridRenderItem {
  item: Zotero.Item;
  title: string;
  creators: string;
  captionTitle: string;
  year: string;
  tags: TagIndicator[];
  iconName: string;
  typeLabel: string;
}

export class GridRenderer {
  private readonly doc: Document;
  private readonly originalPosition: string;
  private readonly spacer: HTMLElement;
  private renderVersion = 0;
  private renderKey?: string;
  private renderItems: GridRenderItem[] = [];
  private readonly layoutObserver: ResizeObserver;
  private readonly styleObserver: MutationObserver;
  private layoutKey?: string;
  private layoutRows: (GridRowGeometry & { margin: number })[] = [];
  private layoutColumns = 1;
  private layoutWidths: number[] = [];
  private readonly coverObserver: IntersectionObserver;
  private readonly captionObserver: ResizeObserver;
  private readonly entries = new Map<number, HTMLElement>();
  private selectedIDs = new Set<number>();
  private focusedItemID?: number;
  private dragEntry?: HTMLElement;
  private pendingItems?: { items: Zotero.Item[]; options: GridRenderOptions };
  private pendingDragCover?: number;
  private destroyed = false;

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
    this.originalPosition = this.host.style.position;
    this.host.style.position = "relative";
    this.spacer = doc.createElement("div");
    this.spacer.className = "grid-view-spacer";
    this.spacer.setAttribute("aria-hidden", "true");
    this.spacer.style.gridColumn = "1 / -1";
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
    this.host.addEventListener("scroll", this.handleScroll);
    doc.addEventListener("focus", this.handleDocumentFocus, true);
    doc.addEventListener("dragend", this.handleDragFinished, true);
    doc.addEventListener("drop", this.handleDragFinished, true);
    doc.defaultView!.addEventListener("blur", this.handleWindowBlur);
    doc.defaultView!.addEventListener("focus", this.handleWindowFocus);
    this.layoutObserver = new doc.defaultView!.ResizeObserver(() =>
      this.refreshLayout(),
    );
    this.layoutObserver.observe(this.host);
    this.styleObserver = new doc.defaultView!.MutationObserver(() =>
      this.refreshLayout(),
    );
    this.styleObserver.observe(this.host, {
      attributes: true,
      attributeFilter: ["style", "hidden"],
    });
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
    this.captionObserver = new doc.defaultView!.ResizeObserver(
      (entries: ResizeObserverEntry[]) => {
        for (const { target } of entries) {
          if (this.host.contains(target))
            this.updateTagOverflow(target as HTMLElement);
        }
      },
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
    if (!event.defaultPrevented) {
      this.dragEntry = this.entries.get(itemID);
      this.mountViewport();
    }
  };

  private readonly handleDragEnd = (): void => {
    this.dragEntry = undefined;
    const pending = this.pendingItems;
    const coverID = this.pendingDragCover;
    this.pendingItems = undefined;
    this.pendingDragCover = undefined;
    if (pending) this.setItems(pending.items, pending.options);
    if (coverID !== undefined) this.refreshCover(coverID);
    this.mountViewport();
  };

  private readonly handleDragFinished = (): void => {
    const source = this.dragEntry;
    if (!source) return;
    // Grid/native drag handlers may stop propagation. Capture the event but do
    // not retire its target or apply queued item updates until dispatch ends.
    this.doc.defaultView!.queueMicrotask(() => {
      if (!this.destroyed && this.dragEntry === source) this.handleDragEnd();
    });
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
    // Zotero matches physical number keys even when NumLock changes their key
    // value to End, arrows, etc. Resolve these before grid navigation.
    const tagKey = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
    if (tagKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.onItemCommand?.("toggle-tag", { tagNumber: Number(tagKey[1]) });
      return;
    }
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
    if (this.destroyed) return;
    // Replacing a native drag source can cancel Gecko's drag session. Keep only
    // the latest update and apply it once the source is no longer needed.
    if (this.dragEntry) {
      this.pendingItems = { items, options };
      return;
    }
    this.host.classList.toggle(
      "desaturate-online-covers",
      options.desaturateOnlineCovers ?? getPref("desaturateOnlineCovers"),
    );
    const scrollTop = this.host.scrollTop;
    const renderItems = items.map((item) => this.renderItem(item, options));
    const renderKey = this.makeRenderKey(renderItems);
    if (renderKey === this.renderKey) {
      let captionsChanged = false;
      for (const [index, rendered] of renderItems.entries()) {
        const previous = this.renderItems[index];
        if (
          rendered.captionTitle === previous.captionTitle &&
          rendered.creators === previous.creators &&
          rendered.year === previous.year &&
          rendered.iconName === previous.iconName &&
          rendered.typeLabel === previous.typeLabel &&
          JSON.stringify(rendered.tags) === JSON.stringify(previous.tags)
        )
          continue;
        captionsChanged = true;
        const entry = this.entries.get(rendered.item.id);
        if (entry) {
          this.updateCaption(entry, rendered);
          this.updateItemTypeBadge(entry, rendered);
        }
      }
      this.renderItems = renderItems;
      if (captionsChanged) this.layoutKey = undefined;
      this.refreshLayout();
      return;
    }
    this.renderKey = renderKey;

    this.renderItems = renderItems;
    this.layoutKey = undefined;
    ++this.renderVersion;
    this.coverObserver.disconnect();
    this.captionObserver.disconnect();
    for (const entry of this.entries.values())
      entry.classList.remove("drop-target");
    this.entries.clear();
    this.host.replaceChildren();
    this.refreshLayout();
    this.updateActiveDescendant();
    this.host.scrollTop = scrollTop;
    this.mountViewport();
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
    const year = options.showYears === false ? "" : getItemYear(item);
    const iconName =
      options.showItemTypeIcon === false
        ? ""
        : item.getItemTypeIconName?.() || "";
    return {
      item,
      title,
      captionTitle: options.showTitles === false ? "" : title,
      creators: options.showCreators ? item.firstCreator : "",
      year,
      tags: options.showTitles === false ? [] : getTagIndicators(item),
      iconName,
      typeLabel: iconName
        ? Zotero.ItemTypes.getLocalizedString(item.itemTypeID)
        : "",
    };
  }

  /** Replace only the edited tile; leave other covers and offscreen tiles alone. */
  refreshCover(itemID: number): void {
    if (this.destroyed) return;
    if (this.dragEntry === this.entries.get(itemID) && this.dragEntry) {
      this.pendingDragCover = itemID;
      return;
    }
    const index = this.renderItems.findIndex(({ item }) => item.id === itemID);
    if (index < 0) return;
    const item = Zotero.Items.get(itemID);
    if (!item || Array.isArray(item)) return;
    this.renderItems[index] = this.renderItem(item, {
      showCreators: getPref("showCreators"),
      showTitles: getPref("showTitles"),
      showYears: getPref("showYears"),
      showItemTypeIcon: getPref("showItemTypeIcon"),
    });
    this.renderKey = this.makeRenderKey(this.renderItems);
    this.layoutKey = undefined;
    const oldEntry = this.entries.get(itemID);
    if (!oldEntry) {
      this.refreshLayout();
      return;
    }
    this.releaseTileObservers(oldEntry);
    const replacement = this.buildTile(this.renderItems[index], index);
    oldEntry.replaceWith(replacement);
    this.refreshLayout();
    this.updateActiveDescendant();
  }

  private readonly handleScroll = (): void => this.mountViewport();

  private isVisible(): boolean {
    return this.host.clientWidth > 0 && this.host.clientHeight > 0;
  }

  private mountViewport(): void {
    if (this.destroyed || !this.isVisible()) return;
    const top = this.host.scrollTop - TILE_OVERSCAN;
    const bottom = this.host.scrollTop + this.host.clientHeight + TILE_OVERSCAN;
    const required = new Set<number>();
    // Jump directly to the first intersecting row instead of walking visited rows.
    let low = 0;
    let high = this.layoutRows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const row = this.layoutRows[middle];
      if (row.top + row.height < top) low = middle + 1;
      else high = middle;
    }
    for (let row = low; row < this.layoutRows.length; row++) {
      const geometry = this.layoutRows[row];
      if (geometry.top > bottom) break;
      if (geometry.top + geometry.height < top) continue;
      const end = Math.min(
        (row + 1) * this.layoutColumns,
        this.renderItems.length,
      );
      for (let index = row * this.layoutColumns; index < end; index++) {
        required.add(this.renderItems[index].item.id);
        this.mountItem(index);
      }
    }
    for (const [itemID, entry] of this.entries) {
      if (
        required.has(itemID) ||
        itemID === this.focusedItemID ||
        entry === this.dragEntry
      )
        continue;
      this.releaseTileObservers(entry);
      this.entries.delete(itemID);
      entry.remove();
    }
    this.updateActiveDescendant();
  }

  private releaseTileObservers(entry: HTMLElement): void {
    this.coverObserver.unobserve(entry);
    this.captionObserver.unobserve(entry);
    entry.classList.remove("drop-target");
  }

  private positionTile(entry: HTMLElement, index: number): void {
    const row = this.layoutRows[Math.floor(index / this.layoutColumns)];
    if (!row) return;
    const column = index % this.layoutColumns;
    const trackWidth = this.layoutWidths[column];
    const style = this.doc.defaultView!.getComputedStyle(this.host)!;
    const tileSize = parseFloat(
      style.getPropertyValue("--cover-view-tile-size"),
    );
    const width = Math.min(tileSize || trackWidth, trackWidth);
    const gap = parseFloat(style.columnGap) || 0;
    const rtl = style.direction === "rtl";
    const preceding =
      this.layoutWidths.slice(0, column).reduce((sum, size) => sum + size, 0) +
      column * gap;
    // The spacer spans the resolved tracks, so its rectangle also captures
    // justify-content and RTL alignment without reproducing CSS track packing.
    const tracks = this.spacer.getBoundingClientRect();
    const viewport = this.host.getBoundingClientRect();
    const trackLeft = rtl
      ? tracks.right - preceding - trackWidth
      : tracks.left + preceding;
    const offset =
      trackLeft -
      viewport.left -
      this.host.clientLeft +
      this.host.scrollLeft +
      (trackWidth - width) / 2;
    entry.style.position = "absolute";
    entry.style.top = `${row.top - row.margin}px`;
    entry.style.left = `${offset}px`;
    entry.style.right = "auto";
    entry.style.width = `${width}px`;
    const tileStyle = this.doc.defaultView!.getComputedStyle(entry)!;
    const inset = [
      tileStyle.paddingTop,
      tileStyle.paddingBottom,
      tileStyle.borderTopWidth,
      tileStyle.borderBottomWidth,
    ].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    entry.style.height = `${row.height - inset}px`;
  }

  private mountItem(index: number): HTMLElement {
    const rendered = this.renderItems[index];
    const existing = this.entries.get(rendered.item.id);
    if (existing) return existing;
    const entry = this.buildTile(rendered, index);
    // Keep DOM order (and menu anchoring) consistent with native item order even
    // when rows are visited out of sequence.
    const next = Array.from(this.host.children).find(
      (child) => Number((child as HTMLElement).dataset.renderIndex) > index,
    );
    this.host.insertBefore(entry, next ?? this.spacer);
    this.positionTile(entry, index);
    return entry;
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
    entry.setAttribute("aria-posinset", String(renderIndex + 1));
    entry.setAttribute("aria-setsize", String(this.renderItems.length));
    entry.style.position = "absolute";
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
    this.updateItemTypeBadge(entry, rendered);
    this.updateCaption(entry, rendered);
    this.coverObserver.observe(entry);
    this.captionObserver.observe(entry);

    return entry;
  }

  private updateItemTypeBadge(
    entry: HTMLElement,
    rendered: GridRenderItem,
  ): void {
    entry.querySelector(".grid-view-item-type-badge")?.remove();
    entry.removeAttribute("aria-description");
    if (!rendered.iconName) return;
    const badge = this.doc.createElement("span");
    badge.className = "grid-view-item-type-badge";
    badge.title = rendered.typeLabel;
    badge.setAttribute("aria-hidden", "true");
    // Use the same CSS icon and variant name as Zotero's native item tree.
    const icon = this.doc.createElement("span");
    icon.className = "icon icon-css icon-item-type";
    icon.dataset.itemType = rendered.iconName;
    badge.appendChild(icon);
    entry.querySelector(".grid-view-cover")!.appendChild(badge);
    entry.setAttribute("aria-description", rendered.typeLabel);
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
    this.updateTagOverflow(entry);
  }

  private updateTagOverflow(entry: HTMLElement): void {
    const row = entry.querySelector<HTMLElement>(".grid-view-title-row");
    const group = row?.querySelector<HTMLElement>(".grid-view-tags");
    if (!row || !group || !row.clientWidth) return;
    group.querySelector(".grid-view-tag-overflow")?.remove();
    const indicators: HTMLElement[] = Array.from(
      group.querySelectorAll<HTMLElement>(".grid-view-tag"),
    );
    for (const indicator of indicators) indicator.hidden = false;
    // Leave more than half the line for the title, including the inter-group gap.
    const budget = row.clientWidth * 0.45;
    if (group.getBoundingClientRect().width <= budget) return;
    const overflow = this.doc.createElement("span");
    overflow.className = "grid-view-tag-overflow";
    group.appendChild(overflow);
    let visible = indicators.length;
    do {
      indicators[--visible].hidden = true;
      overflow.textContent = `+${indicators.length - visible}`;
    } while (visible > 0 && group.getBoundingClientRect().width > budget);
    overflow.title = indicators
      .slice(visible)
      .map((indicator) => indicator.title)
      .join("\n");
    overflow.setAttribute("aria-label", overflow.title);
  }

  private buildCaption({
    captionTitle,
    creators,
    year,
    tags,
  }: GridRenderItem): HTMLElement | undefined {
    const caption = this.doc.createElement("figcaption");
    if (captionTitle) {
      const titleRow = this.doc.createElement("span");
      titleRow.className = "grid-view-title-row";
      if (tags.length) {
        const indicators = this.doc.createElement("span");
        indicators.className = "grid-view-tags";
        for (const { tag, color, emoji } of tags) {
          const indicator = this.doc.createElement("span");
          indicator.className = "grid-view-tag";
          indicator.title = tag;
          indicator.setAttribute("aria-label", tag);
          if (emoji) {
            indicator.classList.add("grid-view-tag-emoji");
            indicator.textContent = emoji;
          } else if (color) {
            indicator.classList.add("grid-view-tag-swatch");
            indicator.style.color = color;
            indicator.dataset.color = color.toLowerCase();
          }
          indicators.appendChild(indicator);
        }
        titleRow.appendChild(indicators);
      }
      const titleLine = this.doc.createElement("span");
      titleLine.className = "grid-view-title";
      titleLine.textContent = captionTitle;
      titleLine.title = captionTitle;
      titleRow.appendChild(titleLine);
      caption.appendChild(titleRow);
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
    const cover = await CoverProvider.getCoverResult(item.id);
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
    image.dataset.coverSource = cover.source;
    const frame = entry.querySelector<HTMLElement>(".grid-view-cover")!;
    if (cover.source === "online") {
      frame.style.setProperty(
        "--cover-view-online-cover",
        `url(${JSON.stringify(cover.uri)})`,
      );
    } else {
      frame.style.removeProperty("--cover-view-online-cover");
    }
    image.src = cover.uri;
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
    if (itemID !== undefined) this.revealItem(itemID, scroll);
    for (const [entryItemID, entry] of this.entries) {
      entry.classList.toggle("focused", entryItemID === itemID);
    }
    this.mountViewport();
    this.updateActiveDescendant();
  }

  /** Choose the last selected tile in grid order that intersects the viewport. */
  ensureVisibleMenuAnchor(
    selectedIDs: readonly number[],
  ): HTMLElement | undefined {
    const selected = new Set(selectedIDs);
    const viewport = this.host.getBoundingClientRect();
    let visible: HTMLElement | undefined;
    for (const { item } of this.renderItems) {
      const entry = this.entries.get(item.id);
      if (!entry) continue;
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
    this.revealItem(last.item.id, true);
    const entry = this.entries.get(last.item.id);
    return entry;
  }

  /** Find an adjacent row in top-level item order, without mounting tiles. */
  getVerticalDestination(
    itemID: number,
    direction: -1 | 1,
  ): number | undefined {
    const index = this.renderItems.findIndex(({ item }) => item.id === itemID);
    if (index < 0) return undefined;
    const columns = this.getColumnWidths().length;
    const rowStart = (Math.floor(index / columns) + direction) * columns;
    if (rowStart < 0 || rowStart >= this.renderItems.length) return undefined;
    return this.renderItems[
      Math.min(rowStart + (index % columns), this.renderItems.length - 1)
    ].item.id;
  }

  private getColumnWidths(): number[] {
    // Gecko resolves auto-fill/minmax tracks against the current content width,
    // including padding, column gaps and the scrollbar. No tile lookup needed.
    const tracks = this.doc
      .defaultView!.getComputedStyle(this.host)!
      .gridTemplateColumns.split(/\s+/)
      .filter((track) => /^\d+(?:\.\d+)?px$/.test(track))
      .map(parseFloat);
    return tracks.length ? tracks : [this.host.clientWidth];
  }

  /** Move about one viewport in the current visual column, including unmounted rows. */
  getPageDestination(itemID: number, direction: -1 | 1): number | undefined {
    const index = this.renderItems.findIndex(({ item }) => item.id === itemID);
    if (index < 0) return undefined;
    const widths = this.getColumnWidths();
    const rows = this.getLayoutRows(widths);
    if (!rows.length) return undefined;
    const viewportTop = this.host.scrollTop - this.host.clientTop;
    const destinationRow = getPageRow(
      rows,
      Math.floor(index / widths.length),
      direction,
      viewportTop,
      viewportTop + this.host.getBoundingClientRect().height,
    );
    return this.renderItems[
      Math.min(
        destinationRow * widths.length + (index % widths.length),
        this.renderItems.length - 1,
      )
    ].item.id;
  }

  private getLayoutRows(
    widths: number[],
  ): (GridRowGeometry & { margin: number })[] {
    const style = this.doc.defaultView!.getComputedStyle(this.host)!;
    const gap = parseFloat(style.rowGap) || 0;
    const heights = new Map<string, { height: number; margin: number }>();
    const rows: (GridRowGeometry & { margin: number })[] = [];
    let top = parseFloat(style.paddingTop) || 0;

    for (
      let start = 0;
      start < this.renderItems.length;
      start += widths.length
    ) {
      let rowHeight = 0;
      let rowMargin = 0;
      for (let column = 0; column < widths.length; column++) {
        const rendered = this.renderItems[start + column];
        if (!rendered) break;
        const key = JSON.stringify([
          widths[column],
          !!rendered.captionTitle,
          !!(rendered.creators || rendered.year),
          rendered.tags.map(({ emoji }) => !!emoji),
        ]);
        let size = heights.get(key);
        if (!size) {
          size = this.measureTile(rendered, widths[column]);
          heights.set(key, size);
        }
        rowHeight = Math.max(rowHeight, size.height);
        rowMargin = size.margin;
      }
      rows.push({ top: top + rowMargin, height: rowHeight, margin: rowMargin });
      // Negative tile margins extend selection decoration, not row spacing.
      top += rowHeight + 2 * rowMargin + gap;
    }
    return rows;
  }

  private measureTile(
    rendered: GridRenderItem,
    trackWidth: number,
  ): { height: number; margin: number } {
    // A CSS sizing probe shares the displayed cover/caption rules, but is not a
    // mounted item: no item ID, observers, selection, or cover request.
    const probe = this.doc.createElement("figure");
    probe.className = "grid-view-item";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;top:0;left:0";
    const tileSize = parseFloat(
      this.doc
        .defaultView!.getComputedStyle(this.host)!
        .getPropertyValue("--cover-view-tile-size"),
    );
    probe.style.width = `${Math.min(tileSize || trackWidth, trackWidth)}px`;
    const cover = this.doc.createElement("div");
    cover.className = "grid-view-cover";
    probe.append(cover);
    const caption = this.buildCaption(rendered);
    if (caption) probe.append(caption);
    this.host.append(probe);
    try {
      return {
        // Gecko lays out in 1/60px app units; DOMRect's float precision must not
        // accumulate into a different visibility decision after many rows.
        height: Math.round(probe.getBoundingClientRect().height * 60) / 60,
        margin:
          parseFloat(
            this.doc.defaultView!.getComputedStyle(probe)!.marginTop,
          ) || 0,
      };
    } finally {
      probe.remove();
    }
  }

  private revealItem(itemID: number, scroll: boolean): void {
    if (!this.isVisible()) return;
    this.refreshLayout();
    const itemIndex = this.renderItems.findIndex(
      ({ item }) => item.id === itemID,
    );
    if (itemIndex < 0) return;
    const entry = this.mountItem(itemIndex);
    if (scroll) {
      entry.scrollIntoView({ block: "nearest", inline: "nearest" });
      this.mountViewport();
    }
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
    // Hidden tabs report zero dimensions: retain the last valid geometry until
    // Zotero restores the library tab and calls us again.
    if (this.destroyed || !this.isVisible()) return;
    const scrollTop = this.host.scrollTop;
    if (!this.host.contains(this.spacer)) this.host.append(this.spacer);
    // A spacer avoids Gecko's 10,000 explicit-grid-row limit. A second pass
    // accounts for the scrollbar reducing auto-fill widths after setting height.
    for (let pass = 0; pass < 2; pass++) {
      const widths = this.getColumnWidths();
      const style = this.doc.defaultView!.getComputedStyle(this.host)!;
      const key = JSON.stringify([
        widths,
        style.rowGap,
        style.columnGap,
        style.paddingTop,
        style.paddingBottom,
        style.paddingLeft,
        style.paddingRight,
        style.direction,
        style.justifyContent,
        style.getPropertyValue("--cover-view-tile-size"),
        style.font,
        style.lineHeight,
      ]);
      if (key === this.layoutKey) break;
      this.layoutRows = this.getLayoutRows(widths);
      this.layoutColumns = widths.length;
      this.layoutWidths = widths;
      this.layoutKey = key;
      const lastRow = this.layoutRows.at(-1);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      this.spacer.style.height = `${lastRow ? lastRow.top + lastRow.height + lastRow.margin - paddingTop : 0}px`;
      for (const entry of this.entries.values())
        this.positionTile(entry, Number(entry.dataset.renderIndex));
    }
    this.host.scrollTop = scrollTop > 0 ? scrollTop - 1 : 1;
    this.host.scrollTop = scrollTop;
    this.mountViewport();
    if (this.focusedItemID !== undefined) {
      const index = this.renderItems.findIndex(
        ({ item }) => item.id === this.focusedItemID,
      );
      if (index >= 0) this.mountItem(index);
    }
    this.updateActiveDescendant();
  }

  destroy(): void {
    this.destroyed = true;
    this.renderVersion++;
    this.renderKey = undefined;
    this.host.removeEventListener("click", this.handleClick);
    this.host.removeEventListener("dblclick", this.handleDoubleClick);
    this.host.removeEventListener("contextmenu", this.handleContextMenu);
    this.host.removeEventListener("dragstart", this.handleDragStart);
    this.host.removeEventListener("keydown", this.handleKeyDown);
    this.host.removeEventListener("focus", this.handleFocus);
    this.host.removeEventListener("blur", this.handleBlur);
    this.host.removeEventListener("scroll", this.handleScroll);
    this.doc.removeEventListener("focus", this.handleDocumentFocus, true);
    this.doc.removeEventListener("dragend", this.handleDragFinished, true);
    this.doc.removeEventListener("drop", this.handleDragFinished, true);
    this.doc.defaultView!.removeEventListener("blur", this.handleWindowBlur);
    this.doc.defaultView!.removeEventListener("focus", this.handleWindowFocus);
    this.layoutObserver.disconnect();
    this.styleObserver.disconnect();
    this.coverObserver.disconnect();
    this.captionObserver.disconnect();
    this.renderItems = [];
    this.layoutRows = [];
    this.layoutKey = undefined;
    this.layoutWidths = [];
    this.host.style.position = this.originalPosition;
    this.entries.clear();
    this.selectedIDs.clear();
    this.focusedItemID = undefined;
    this.dragEntry = undefined;
    this.pendingItems = undefined;
    this.pendingDragCover = undefined;
    this.host.replaceChildren();
    this.host.removeAttribute("aria-activedescendant");
  }
}
