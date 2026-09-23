import { CoverProvider } from "./coverProvider";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";

const CHUNK_SIZE = 120;

export type GridNavigationCommand =
  "left" | "right" | "up" | "down" | "home" | "end";

export interface GridRenderOptions {
  showAuthors: boolean;
}

interface GridRenderItem {
  item: Zotero.Item;
  title: string;
  authors: string;
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
    private readonly onSelect: (itemID: number) => void,
    private readonly onActivate?: (itemID: number) => void,
    private readonly onNavigate?: (command: GridNavigationCommand) => void,
    private readonly onFocus?: () => void,
  ) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
    this.host.tabIndex = 0;
    this.host.setAttribute("role", "listbox");
    this.host.setAttribute("aria-multiselectable", "true");
    this.host.addEventListener("click", this.handleClick);
    this.host.addEventListener("dblclick", this.handleDoubleClick);
    this.host.addEventListener("keydown", this.handleKeyDown);
    this.host.addEventListener("focus", this.handleFocus);
    this.host.addEventListener("blur", this.handleBlur);
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

  private readonly handleClick = (event: Event): void => {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return;

    const itemID = Number(entry.dataset.itemId);
    if (Number.isSafeInteger(itemID)) {
      this.host.focus();
      this.onSelect(itemID);
    }
  };

  private readonly handleDoubleClick = (event: Event): void => {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return;

    const itemID = Number(entry.dataset.itemId);
    if (Number.isSafeInteger(itemID)) this.onActivate?.(itemID);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const command = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      Home: "home",
      End: "end",
    }[event.key] as GridNavigationCommand | undefined;
    if (!command) return;

    event.preventDefault();
    this.onNavigate?.(command);
  };

  private readonly handleFocus = (): void => {
    this.host.classList.add("owns-focus");
    this.onFocus?.();
  };

  private readonly handleBlur = (): void => {
    this.host.classList.remove("owns-focus");
  };

  setItems(items: Zotero.Item[], options: GridRenderOptions): void {
    const scrollTop = this.host.scrollTop;
    const renderItems = items.map((item) => ({
      item,
      title: item.getDisplayTitle(),
      authors: options.showAuthors ? item.firstCreator : "",
    }));
    const renderKey = JSON.stringify([
      options.showAuthors,
      getPref("fetchISBNCover"),
      renderItems.map(({ item, title, authors }) => [
        item.id,
        title,
        options.showAuthors ? authors : "",
      ]),
    ]);
    if (renderKey === this.renderKey) return;
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
    { item, title, authors }: GridRenderItem,
    renderIndex: number,
  ): HTMLElement {
    const entry = this.doc.createElement("figure");
    entry.className = "grid-view-item";
    entry.dataset.itemId = String(item.id);
    entry.dataset.renderIndex = String(renderIndex);
    entry.classList.toggle("selected", this.selectedIDs.has(item.id));
    entry.classList.toggle("focused", this.focusedItemID === item.id);
    entry.id = `${this.host.id || "cover-view-grid"}-item-${item.id}`;
    entry.setAttribute("role", "option");
    entry.setAttribute("aria-selected", String(this.selectedIDs.has(item.id)));
    this.entries.set(item.id, entry);

    const coverFrame = this.doc.createElement("div");
    coverFrame.className = "grid-view-cover";

    const image = this.doc.createElement("img");
    image.alt = getString("cover-view-image-alt", { args: { title } });
    image.hidden = true;
    coverFrame.appendChild(image);

    const caption = this.doc.createElement("figcaption");
    const titleLine = this.doc.createElement("span");
    titleLine.className = "grid-view-title";
    titleLine.textContent = title;
    titleLine.title = title;
    caption.appendChild(titleLine);

    if (authors) {
      const authorLine = this.doc.createElement("span");
      authorLine.className = "grid-view-authors";
      authorLine.textContent = authors;
      authorLine.title = authors;
      caption.appendChild(authorLine);
    }

    entry.append(coverFrame, caption);
    this.coverObserver.observe(entry);

    return entry;
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
    this.host.removeEventListener("keydown", this.handleKeyDown);
    this.host.removeEventListener("focus", this.handleFocus);
    this.host.removeEventListener("blur", this.handleBlur);
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
