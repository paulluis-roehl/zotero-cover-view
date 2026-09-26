import { attachTileSizePreference } from "./modules/tileSizePreference";

declare const document: Document;

// Zotero loads pane scripts before inserting the XHTML, then dispatches `load`
// on each top-level element of the newly inserted pane.
document.addEventListener(
  "load",
  (event) => {
    const root = event.target;
    if (!(root instanceof Element)) return;
    const slider = root.querySelector<HTMLInputElement>(
      "#zotero-prefpane-coverview-tile-size",
    );
    const percentage = root.querySelector<HTMLInputElement>(
      "#zotero-prefpane-coverview-tile-size-percent",
    );
    if (!slider || !percentage) return;
    const detach = attachTileSizePreference(slider, percentage);
    root.addEventListener("unload", detach, { once: true });
  },
  true,
);
