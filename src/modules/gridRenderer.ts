import { CoverProvider } from "./coverProvider";

export class GridRenderer {
  private readonly doc: Document;
  private renderVersion = 0;
  private readonly entries = new Map<number, HTMLElement>();
  private selectedIDs = new Set<number>();

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (itemID: number) => void,
  ) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
    this.host.addEventListener("click", this.handleClick);
  }

  private readonly handleClick = (event: Event): void => {
    const entry = (event.target as Element | null)?.closest(
      ".grid-view-item",
    ) as HTMLElement | null;
    if (!entry || !this.host.contains(entry)) return;

    const itemID = Number(entry.dataset.itemId);
    if (Number.isSafeInteger(itemID)) this.onSelect(itemID);
  };

  setItems(items: Zotero.Item[]): void {
    const renderVersion = ++this.renderVersion;
    const fragment = this.doc.createDocumentFragment();
    this.entries.clear();

    for (const item of items) {
      const title = item.getDisplayTitle();
      const entry = this.doc.createElement("figure");
      entry.className = "grid-view-item";
      entry.dataset.itemId = String(item.id);
      entry.classList.toggle("selected", this.selectedIDs.has(item.id));
      this.entries.set(item.id, entry);

      const coverFrame = this.doc.createElement("div");
      coverFrame.className = "grid-view-cover";

      const image = this.doc.createElement("img");
      image.alt = `Cover for ${title}`;
      image.hidden = true;
      coverFrame.appendChild(image);

      const caption = this.doc.createElement("figcaption");
      caption.textContent = title;
      caption.title = title;

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
  }

  /** Update selection presentation without rebuilding tiles or reloading covers. */
  setSelection(itemIDs: readonly number[]): void {
    this.selectedIDs = new Set(itemIDs);
    for (const [itemID, entry] of this.entries) {
      entry.classList.toggle("selected", this.selectedIDs.has(itemID));
    }
  }

  destroy(): void {
    this.renderVersion++;
    this.host.removeEventListener("click", this.handleClick);
    this.entries.clear();
    this.selectedIDs.clear();
    this.host.replaceChildren();
  }
}
