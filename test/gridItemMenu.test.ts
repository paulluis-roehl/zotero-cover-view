import { assert } from "chai";
import { ItemTreeBridge } from "../src/modules/itemTreeBridge";

describe("grid keyboard item menu", function () {
  it("uses native selection and the last visible selected tile, waiting for pending writes", async function () {
    this.timeout(120000);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const originalStyle = grid.style.cssText;
    const collection = new Zotero.Collection();
    const items: Zotero.Item[] = [];
    const originalOpener = Object.getOwnPropertyDescriptor(
      pane,
      "onItemsContextMenuOpen",
    );
    const originalSelectItems = Object.getOwnPropertyDescriptor(
      pane,
      "selectItems",
    );
    const toolkit = Zotero.CoverView.data.ztoolkit;
    const originalLog = toolkit.log;
    const calls: Array<{
      selected: number[];
      anchor: HTMLElement;
      x: number;
      y: number;
    }> = [];
    const logs: unknown[][] = [];
    const press = (key: string, modifiers = {}) => {
      const event = new win.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      grid.dispatchEvent(event);
      return event;
    };
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), "Timed out waiting for grid/menu update");
    };
    const override = (name: string, value: unknown) =>
      Object.defineProperty(pane, name, { configurable: true, value });
    try {
      collection.name = `Keyboard menu ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      for (let index = 0; index < 5; index++) {
        const item = new Zotero.Item("book");
        item.setField("title", `Keyboard menu ${index}`);
        item.addToCollection(collection.id);
        await item.saveTx();
        items.push(item);
      }
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      grid.style.gridTemplateColumns = "repeat(1, 150px)";
      await waitFor(
        () => grid.querySelectorAll(".grid-view-item").length === 5,
      );
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const ids = entries.map((entry) => Number(entry.dataset.itemId));
      const rowHeight = entries[1].offsetTop - entries[0].offsetTop;
      assert.isAbove(rowHeight, 0);
      grid.style.flex = "none";
      grid.style.height = `${rowHeight * 2 - 1}px`;
      grid.scrollTop = 0;
      override(
        "onItemsContextMenuOpen",
        async (event: { target: HTMLElement }, x: number, y: number) => {
          calls.push({
            selected: pane.getSelectedItems(true),
            anchor: event.target,
            x,
            y,
          });
        },
      );
      toolkit.log = (...args: unknown[]) => {
        logs.push(args);
      };

      pane.itemsView!.selection.clearSelection();
      grid.focus();
      await waitFor(() => grid.hasAttribute("aria-activedescendant"));
      assert.isTrue(press("ContextMenu").defaultPrevented);
      await Zotero.Promise.delay(50);
      assert.isEmpty(calls, "Focus alone does not imply selection");

      await pane.selectItems([ids[0], ids[1], ids[4]]);
      await waitFor(() => pane.getSelectedItems(true).length === 3);
      grid.scrollTop = 0;
      const focusBefore = grid.getAttribute("aria-activedescendant");
      assert.isTrue(press("F10", { shiftKey: true }).defaultPrevented);
      await waitFor(() => calls.length === 1);
      assert.sameMembers(calls[0].selected, [ids[0], ids[1], ids[4]]);
      assert.strictEqual(
        calls[0].anchor,
        entries[1],
        "Last visible selected tile",
      );
      assert.equal(
        calls[0].x,
        Math.round(
          win.mozInnerScreenX + entries[1].getBoundingClientRect().right,
        ),
      );
      assert.equal(
        calls[0].y,
        Math.round(
          win.mozInnerScreenY + entries[1].getBoundingClientRect().top,
        ),
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), focusBefore);

      grid.scrollTop = rowHeight * 3;
      await pane.selectItems([ids[0], ids[1]]);
      press("ContextMenu");
      await waitFor(() => calls.length === 2);
      assert.strictEqual(
        calls[1].anchor,
        entries[1],
        "Last offscreen selected tile in grid order scrolled into view",
      );
      assert.isAtMost(grid.scrollTop, rowHeight * 2);
      assert.equal(grid.getAttribute("aria-activedescendant"), focusBefore);

      await pane.selectItems([ids[1]]);
      grid.scrollTop = entries[1].offsetTop + entries[1].offsetHeight - 1;
      press("ContextMenu");
      await waitFor(() => calls.length === 3);
      assert.strictEqual(calls[2].anchor, entries[1]);
      assert.isAtLeast(
        calls[2].y,
        Math.round(win.mozInnerScreenY + grid.getBoundingClientRect().top),
        "Clipped tile anchors within the grid viewport",
      );

      const nativeSelect = pane.selectItems.bind(pane);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      override("selectItems", async (selected: number[]) => {
        await pending;
        return nativeSelect(selected);
      });
      entries[2].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      press("ContextMenu");
      await Zotero.Promise.delay(30);
      assert.lengthOf(calls, 3, "Menu waits for selection write");
      release();
      await waitFor(() => calls.length === 4);
      assert.deepEqual(calls[3].selected, [ids[2]]);
      assert.strictEqual(calls[3].anchor, entries[2]);

      override("onItemsContextMenuOpen", undefined);
      press("ContextMenu");
      await waitFor(() => logs.length > 0);
      assert.lengthOf(calls, 4);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[2].id);
      assert.match(
        String(logs.at(-1)![0]),
        /Failed to open selected grid items menu/,
      );

      const logCount = logs.length;
      override("onItemsContextMenuOpen", async () => {
        throw new Error("Menu opener failed");
      });
      press("F10", { shiftKey: true });
      await waitFor(() => logs.length > logCount);
      assert.match(String(logs.at(-1)![1]), /Menu opener failed/);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[2].id);
    } finally {
      if (originalOpener)
        Object.defineProperty(pane, "onItemsContextMenuOpen", originalOpener);
      else Reflect.deleteProperty(pane, "onItemsContextMenuOpen");
      if (originalSelectItems)
        Object.defineProperty(pane, "selectItems", originalSelectItems);
      else Reflect.deleteProperty(pane, "selectItems");
      toolkit.log = originalLog;
      grid.style.cssText = originalStyle;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of items) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("calls the installed Zotero item-menu opener and displays its native popup", async function () {
    const win = Zotero.getMainWindow()!;
    const bridge = new ItemTreeBridge(win);
    const pane = win.ZoteroPane;
    const popup = win.document.getElementById(
      "zotero-itemmenu",
    ) as XULPopupElement;
    const item = new Zotero.Item("book");
    item.setField("title", "Native keyboard item menu contract");
    await item.saveTx();
    const anchor = win.document.getElementById("cover-view-toggle")!;
    let shown = false;
    const onShowing = () => {
      shown = true;
    };
    popup.addEventListener("popupshowing", onShowing);
    try {
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      await pane.selectItems([item.id]);
      await bridge.openSelectedItemsMenu(anchor);
      assert.isTrue(
        shown,
        "Installed Zotero opener builds and opens the native item popup",
      );
    } finally {
      popup.hidePopup();
      popup.removeEventListener("popupshowing", onShowing);
      bridge.destroy();
      await item.eraseTx();
    }
  });
});
