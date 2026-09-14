import { GridRenderer } from "./gridRenderer";

const gridViews = new Map<Window, GridView>();

type StylableElement = Element & { style: CSSStyleDeclaration };

export class GridView {
  private readonly itemTree: StylableElement;
  private readonly gridHost: HTMLDivElement;
  private readonly renderer: GridRenderer;
  private readonly itemTreeDisplay: string;

  constructor(win: Window) {
    const itemTree = win.document.getElementById(
      "zotero-items-tree",
    ) as StylableElement | null;
    if (!itemTree) {
      throw new Error(
        "Cannot attach grid view: #zotero-items-tree was not found",
      );
    }

    this.itemTree = itemTree;
    this.itemTreeDisplay = itemTree.style.display;
    this.gridHost = win.document.createElement("div");
    this.gridHost.id = "cover-view-grid";
    this.gridHost.hidden = true;
    itemTree.after(this.gridHost);
    this.renderer = new GridRenderer(this.gridHost);
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.itemTree.style.display = enabled ? "none" : this.itemTreeDisplay;
    this.gridHost.hidden = !enabled;
  }

  destroy(): void {
    this.itemTree.style.display = this.itemTreeDisplay;
    this.renderer.destroy();
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
