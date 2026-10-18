import { CoverProvider } from "./coverProvider";

let columnKey: string | undefined;
let stopCoverChanges: (() => void) | undefined;
let stopCoverRefresh: (() => void) | undefined;
let generation = 0;
const itemGenerations = new Map<number, number>();

function refreshCoverColumn(itemID?: number): void {
  if (itemID === undefined) generation++;
  else itemGenerations.set(itemID, (itemGenerations.get(itemID) ?? 0) + 1);
  // A column-definition refresh rebuilds the native tree and can restore an
  // obsolete selection during a drop. Redraw only cells, not the row model.
  void Zotero.Notifier.trigger(
    "redraw",
    "item",
    itemID === undefined ? [] : [itemID],
  );
}

export async function registerCoverColumn(): Promise<void> {
  if (stopCoverChanges) return;
  // Zotero owns column removal via pluginID. A hot hook restart can reuse the
  // existing registration without resetting the native tree or its sections.
  if (columnKey && Zotero.ItemTreeManager.isCustomColumn(columnKey)) {
    observeCoverChanges();
    return;
  }
  const field = "cover";
  const registered = Zotero.ItemTreeManager.registerColumn({
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
      // Native row data can survive provider invalidation. Always ensure that
      // this render reads a current lookup, even if dataProvider wasn't called.
      const item = Zotero.Items.get(Number(data));
      if (item) CoverProvider.cacheCover(item);
      const requestGeneration = generation;
      const itemGeneration = itemGenerations.get(Number(data));
      const span = doc.createElement("span");
      span.className = `cell ${column.className}`;
      span.style.display = "flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      void CoverProvider.getCover(Number(data)).then((cover) => {
        // Each render owns its cell; never write into a detached/recycled row
        // or publish a lookup from before a refresh or teardown.
        if (
          !cover ||
          requestGeneration !== generation ||
          itemGeneration !== itemGenerations.get(Number(data)) ||
          !span.isConnected
        )
          return;
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
  if (!registered) return;
  columnKey = registered;
  observeCoverChanges();
}

function observeCoverChanges(): void {
  stopCoverChanges = CoverProvider.onCoverChanged(refreshCoverColumn);
  stopCoverRefresh = CoverProvider.onCoversRefreshRequested(refreshCoverColumn);
}

export function unregisterCoverColumn(): void {
  stopCoverChanges?.();
  stopCoverChanges = undefined;
  stopCoverRefresh?.();
  stopCoverRefresh = undefined;
  generation++;
  itemGenerations.clear();
  // Zotero removes plugin-owned columns on actual add-on shutdown. Explicit
  // removal here would queue a tree reset during Item Pane section teardown.
}
