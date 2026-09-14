import { CoverProvider } from "./coverProvider";

export class GridRenderer {
  private readonly doc: Document;
  private renderVersion = 0;

  constructor(private readonly host: HTMLElement) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
  }

  setItems(items: Zotero.Item[]): void {
    const renderVersion = ++this.renderVersion;
    const fragment = this.doc.createDocumentFragment();

    for (const item of items) {
      const title = item.getDisplayTitle();
      const entry = this.doc.createElement("figure");
      entry.className = "grid-view-item";

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

  destroy(): void {
    this.renderVersion++;
    this.host.replaceChildren();
  }
}
