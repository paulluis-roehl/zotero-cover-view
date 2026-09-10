import { CoverProvider } from "./coverProvider";

export class CoverView {
  static async registerCoverColumn() {
    const field = "cover";
    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: field,
      label: "Cover",
      dataProvider: (item: Zotero.Item, _dataKey: string) => {
        CoverProvider.cacheCover(item);
        return String(item.id);
      },
      renderCell(index, data, column, isFirstColumn, doc) {
        const span = doc.createElement("span");
        span.className = `cell ${column.className}`;
        void CoverProvider.getCover(Number(data)).then((cover) => {
          if (!cover) return;
          const image = doc.createElement("img");
          image.alt = "Cover";
          image.style.width = "24px";
          image.style.height = "24px";
          image.style.objectFit = "contain";
          image.addEventListener("error", () => image.remove(), { once: true });
          image.src = cover;
          span.appendChild(image);
        });
        return span;
      },
    });
  }
}
