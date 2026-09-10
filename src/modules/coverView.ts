import { CoverProvider } from "./coverProvider";

export class CoverView {
  static async registerCoverColumn() {
    const field = "cover";
    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: field,
      label: "Cover",
      dataProvider: (item: Zotero.Item, dataKey: string) => {
        return String(item.id);
      },
      renderCell(index, data, column, isFirstColumn, doc) {
        const span = doc.createElement("span");
        span.className = `cell ${column.className}`;
        const image = doc.createElement("img");
        image.alt = "loading...";
        image.style.width = "24px";
        image.style.height = "24px";
        image.style.objectFit = "contain";
        span.appendChild(image);
        void CoverProvider.getCover(Number(data)).then((cover) => {
          image.alt = "Cover";
          image.src = cover;
        });
        return span;
      },
    });
  }
}
