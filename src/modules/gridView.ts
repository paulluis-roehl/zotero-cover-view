const gridViews = new Map<Window, GridView>();

type HideableElement = Element & { hidden: boolean };

export class GridView {
  private readonly itemTree: HideableElement;
  private readonly gridHost: HTMLDivElement;
  private readonly itemTreeWasHidden: boolean;

  constructor(win: Window) {
    const itemTree = win.document.getElementById(
      "zotero-items-tree",
    ) as HideableElement | null;
    if (!itemTree) {
      throw new Error(
        "Cannot attach grid view: #zotero-items-tree was not found",
      );
    }

    this.itemTree = itemTree;
    this.itemTreeWasHidden = itemTree.hidden;
    this.gridHost = win.document.createElement("div");
    this.gridHost.id = "cover-view-grid";
    this.gridHost.hidden = true;
    itemTree.after(this.gridHost);
  }

  setEnabled(enabled: boolean): void {
    this.itemTree.hidden = enabled || this.itemTreeWasHidden;
    this.gridHost.hidden = !enabled;
  }

  destroy(): void {
    this.itemTree.hidden = this.itemTreeWasHidden;
    this.gridHost.remove();
  }
}

export function attachGridView(win: Window): GridView {
  const existing = gridViews.get(win);
  if (existing) return existing;

  const gridView = new GridView(win);
  gridViews.set(win, gridView);
  return gridView;
}

export function detachGridView(win: Window): void {
  const gridView = gridViews.get(win);
  if (!gridView) return;

  gridView.destroy();
  gridViews.delete(win);
}

export function destroyGridViews(): void {
  for (const gridView of gridViews.values()) {
    gridView.destroy();
  }
  gridViews.clear();
}
