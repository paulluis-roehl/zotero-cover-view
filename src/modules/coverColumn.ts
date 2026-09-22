import { CoverProvider } from "./coverProvider";

export async function registerCoverColumn(): Promise<void> {
  const field = "cover";
  await Zotero.ItemTreeManager.registerColumns({
    pluginID: addon.data.config.addonID,
    dataKey: field,
    label: "Cover",
    iconPath: `chrome://${addon.data.config.addonRef}/content/icons/cover-column.svg`,
    width: "32",
    fixedWidth: true,
    dataProvider: (item: Zotero.Item, _dataKey: string) => {
      CoverProvider.cacheCover(item);
      return String(item.id);
    },
    renderCell(index, data, column, isFirstColumn, doc) {
      const span = doc.createElement("span");
      span.className = `cell ${column.className}`;
      span.style.display = "flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
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
