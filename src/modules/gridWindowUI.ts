import { getString } from "../utils/locale";

type StylableElement = Element & { style: CSSStyleDeclaration };

export class GridWindowUI {
  readonly host: HTMLDivElement;
  private readonly itemTree: StylableElement;
  private readonly itemTreeDisplay: string;
  private readonly toggleButton: XULToolBarButtonElement;
  private readonly stylesheet: HTMLLinkElement;

  constructor(
    win: _ZoteroTypes.MainWindow,
    private readonly onToggle: () => void,
  ) {
    const itemTree = win.document.getElementById(
      "zotero-items-tree",
    ) as StylableElement | null;
    if (!itemTree) {
      throw new Error(
        "Cannot attach grid view: #zotero-items-tree was not found",
      );
    }
    const itemsToolbar = win.document.getElementById("zotero-items-toolbar");
    if (!itemsToolbar) {
      throw new Error(
        "Cannot attach grid view: #zotero-items-toolbar was not found",
      );
    }

    this.itemTree = itemTree;
    this.itemTreeDisplay = itemTree.style.display;
    this.stylesheet = ztoolkit.UI.createElement(win.document, "link", {
      namespace: "html",
      enableElementRecord: false,
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/coverView.css`,
      },
    });
    win.document.documentElement?.appendChild(this.stylesheet);

    this.toggleButton = ztoolkit.UI.createElement(
      win.document,
      "toolbarbutton",
      {
        enableElementRecord: false,
        attributes: {
          id: "cover-view-toggle",
          class: "zotero-tb-button",
          tabindex: "-1",
          type: "checkbox",
        },
        listeners: [{ type: "command", listener: this.onToggle }],
      },
    );
    const noteButton = win.document.getElementById("zotero-tb-note-add");
    itemsToolbar.insertBefore(
      this.toggleButton,
      noteButton?.nextSibling ?? null,
    );

    this.host = win.document.createElement("div");
    this.host.id = "cover-view-grid";
    this.host.hidden = true;
    itemTree.after(this.host);
  }

  setEnabled(enabled: boolean): void {
    this.itemTree.style.display = enabled ? "none" : this.itemTreeDisplay;
    this.host.hidden = !enabled;
    this.toggleButton.toggleAttribute("checked", enabled);
    this.toggleButton.setAttribute("aria-pressed", String(enabled));
    this.toggleButton.setAttribute(
      "tooltiptext",
      getString(
        enabled ? "cover-view-switch-to-list" : "cover-view-switch-to-grid",
      ),
    );
  }

  destroy(): void {
    this.toggleButton.removeEventListener("command", this.onToggle);
    this.itemTree.style.display = this.itemTreeDisplay;
    this.host.remove();
    this.toggleButton.remove();
    this.stylesheet.remove();
  }
}
