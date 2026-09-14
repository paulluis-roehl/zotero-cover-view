export class GridRenderer {
  private readonly doc: Document;

  constructor(private readonly host: HTMLElement) {
    const doc = host.ownerDocument;
    if (!doc) throw new Error("Cannot create grid renderer without a document");
    this.doc = doc;
  }

  setItems(items: Zotero.Item[]): void {
    const list = this.doc.createElement("ul");

    for (const item of items) {
      const entry = this.doc.createElement("li");
      entry.textContent = item.getDisplayTitle();
      list.appendChild(entry);
    }

    this.host.replaceChildren(list);
  }

  destroy(): void {
    this.host.replaceChildren();
  }
}
