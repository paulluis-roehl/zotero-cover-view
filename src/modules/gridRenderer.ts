import { CoverProvider } from "./coverProvider";
import { getString } from "../utils/locale";

export interface GridRenderOptions {
  showAuthors: boolean;
}

export class GridRenderer {
  private readonly doc: Document;
  private renderVersion = 0;
  private renderKey?: string;
  private readonly entries = new Map<number, HTMLElement>();
  private selectedIDs = new Set<number>();

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (itemID: number) => void,
    private readonly onActivate?: (itemID: number) => void,
  ) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
    this.host.addEventListener("click", this.handleClick);
    this.host.addEventListener("dblclick", this.handleDoubleClick);
  }

  private readonly handleClick = (event: Event): void => {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return;

    const itemID = Number(entry.dataset.itemId);
    if (Number.isSafeInteger(itemID)) this.onSelect(itemID);
  };

  private readonly handleDoubleClick = (event: Event): void => {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return;

    const itemID = Number(entry.dataset.itemId);
    if (Number.isSafeInteger(itemID)) this.onActivate?.(itemID);
  };

  setItems(items: Zotero.Item[], options: GridRenderOptions): void {
    const scrollTop = this.host.scrollTop;
    const renderItems = items.map((item) => ({
      item,
      title: item.getDisplayTitle(),
      authors: item.firstCreator,
    }));
    const renderKey = JSON.stringify([
      options.showAuthors,
      renderItems.map(({ item, title, authors }) => [
        item.id,
        title,
        options.showAuthors ? authors : "",
      ]),
    ]);
    if (renderKey === this.renderKey) return;
    this.renderKey = renderKey;

    const renderVersion = ++this.renderVersion;
    const fragment = this.doc.createDocumentFragment();
    this.entries.clear();

    for (const { item, title, authors } of renderItems) {
      const entry = this.doc.createElement("figure");
      entry.className = "grid-view-item";
      entry.dataset.itemId = String(item.id);
      entry.classList.toggle("selected", this.selectedIDs.has(item.id));
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

      if (authors && options.showAuthors) {
        const authorLine = this.doc.createElement("span");
        authorLine.className = "grid-view-authors";
        authorLine.textContent = authors;
        authorLine.title = authors;
        caption.appendChild(authorLine);
      }

      entry.append(coverFrame, caption);
      fragment.appendChild(entry);

      CoverProvider.cacheCover(item);
      void CoverProvider.getCover(item.id).then((cover) => {
        if (!cover || renderVersion !== this.renderVersion) return;

        image.addEventListener("load", () => (image.hidden = false), {
          once: true,
        });
        image.src = cover;
      });
    }

    this.host.replaceChildren(fragment);
    this.host.scrollTop = scrollTop;
  }

  /** Update selection presentation without rebuilding tiles or reloading covers. */
  setSelection(itemIDs: readonly number[]): void {
    this.selectedIDs = new Set(itemIDs);
    for (const [itemID, entry] of this.entries) {
      entry.classList.toggle("selected", this.selectedIDs.has(itemID));
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
    this.entries.clear();
    this.selectedIDs.clear();
    this.host.replaceChildren();
  }
}
