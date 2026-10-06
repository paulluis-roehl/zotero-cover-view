import { assert } from "chai";
import { ItemTreeBridge } from "../src/modules/itemTreeBridge";
import { createRendererHost } from "./helpers/rendererHost";

describe("grid item menu", function () {
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
    const originalBuilder = Object.getOwnPropertyDescriptor(
      pane,
      "buildItemContextMenu",
    );
    const popup = win.document.getElementById(
      "zotero-itemmenu",
    ) as XULPopupElement;
    const originalOpen = Object.getOwnPropertyDescriptor(
      popup,
      "openPopupAtScreenRect",
    );
    const originalSelectItems = Object.getOwnPropertyDescriptor(
      pane,
      "selectItems",
    );
    const toolkit = Zotero.CoverView.data.ztoolkit;
    const originalLog = toolkit.log;
    const calls: Array<{
      selected: number[];
      x: number;
      y: number;
      height: number;
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
    const rightClick = (entry: HTMLElement, x: number, y: number) => {
      const event = new win.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        screenX: x,
        screenY: y,
      });
      entry.querySelector(".grid-view-title")!.dispatchEvent(event);
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
      grid.style.height = "1500px";
      grid.style.flex = "none";
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
      override("buildItemContextMenu", async () => {});
      Object.defineProperty(popup, "openPopupAtScreenRect", {
        configurable: true,
        value: (
          _position: string,
          x: number,
          y: number,
          _width: number,
          height: number,
        ) => {
          calls.push({ selected: pane.getSelectedItems(true), x, y, height });
        },
      });
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
      await Zotero.Promise.delay(100);
      const focusBefore = grid.getAttribute("aria-activedescendant");
      assert.isTrue(press("F10", { shiftKey: true }).defaultPrevented);
      await waitFor(() => calls.length === 1);
      assert.sameMembers(calls[0].selected, [ids[0], ids[1], ids[4]]);
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
      assert.equal(
        calls[1].x,
        Math.round(
          win.mozInnerScreenX + entries[1].getBoundingClientRect().right,
        ),
      );
      assert.isAtMost(grid.scrollTop, rowHeight * 2);

      await pane.selectItems([ids[1]]);
      grid.scrollTop = entries[1].offsetTop + entries[1].offsetHeight - 1;
      press("ContextMenu");
      await waitFor(() => calls.length === 3);
      assert.equal(
        calls[2].x,
        Math.round(
          win.mozInnerScreenX + entries[1].getBoundingClientRect().right,
        ),
      );
      assert.isAtLeast(
        calls[2].y,
        Math.round(win.mozInnerScreenY + grid.getBoundingClientRect().top),
        "Clipped tile anchors within the grid viewport",
      );

      await pane.selectItems([ids[4]]);
      grid.scrollTop = grid.scrollHeight;
      press("ContextMenu");
      await waitFor(() => calls.length === 4);
      assert.equal(
        calls[3].x,
        Math.round(
          win.mozInnerScreenX + entries[4].getBoundingClientRect().right,
        ),
      );
      assert.equal(
        calls[3].y,
        Math.round(
          win.mozInnerScreenY + entries[4].getBoundingClientRect().top,
        ),
        "Native popup anchors below the tile's visible top",
      );

      grid.scrollTop =
        entries[4].offsetTop - grid.clientHeight + entries[4].offsetHeight / 2;
      const partial = entries[4].getBoundingClientRect();
      const viewport = grid.getBoundingClientRect();
      assert.isBelow(partial.top, viewport.bottom);
      assert.isAbove(partial.bottom, viewport.bottom);
      press("ContextMenu");
      await waitFor(() => calls.length === 5);
      assert.equal(
        calls[4].x,
        Math.round(
          win.mozInnerScreenX + entries[4].getBoundingClientRect().right,
        ),
      );
      assert.equal(
        calls[4].y,
        Math.round(win.mozInnerScreenY + partial.top),
        "Native popup anchors to the visible top of a half-visible tile",
      );
      assert.equal(calls[4].height, Math.round(viewport.bottom - partial.top));

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
      assert.lengthOf(calls, 5, "Menu waits for selection write");
      release();
      await waitFor(() => calls.length === 6);
      assert.deepEqual(calls[5].selected, [ids[2]]);
      assert.equal(
        calls[5].x,
        Math.round(
          win.mozInnerScreenX + entries[2].getBoundingClientRect().right,
        ),
      );

      await pane.selectItems([ids[0], ids[2]]);
      const selectedMenu = rightClick(entries[0], 412, 527);
      assert.isTrue(selectedMenu.defaultPrevented);
      await waitFor(() => calls.length === 7);
      assert.sameMembers(calls[6].selected, [ids[0], ids[2]]);
      assert.deepEqual(
        [calls[6].x, calls[6].y, calls[6].height],
        [412, 527, 0],
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[0].id);
      assert.equal(win.document.activeElement, grid);
      entries[1].dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
      await waitFor(
        () =>
          pane.getSelectedItems(true).length === 2 &&
          pane.getSelectedItems(true).includes(ids[1]),
      );
      assert.sameMembers(pane.getSelectedItems(true), [ids[0], ids[1]]);

      let releaseRightClick!: () => void;
      const rightClickPending = new Promise<void>((resolve) => {
        releaseRightClick = resolve;
      });
      override("selectItems", async (selected: number[]) => {
        await rightClickPending;
        return nativeSelect(selected);
      });
      assert.isTrue(rightClick(entries[3], 631, 744).defaultPrevented);
      await Zotero.Promise.delay(30);
      assert.lengthOf(calls, 7, "Pointer menu waits for native selection");
      releaseRightClick();
      await waitFor(() => calls.length === 8);
      assert.deepEqual(calls[7].selected, [ids[3]]);
      assert.deepEqual(
        [calls[7].x, calls[7].y, calls[7].height],
        [631, 744, 0],
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[3].id);
      assert.equal(win.document.activeElement, grid);
      entries[4].dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
      await waitFor(() => pane.getSelectedItems(true).includes(ids[4]));
      assert.sameMembers(pane.getSelectedItems(true), [ids[3], ids[4]]);

      override("buildItemContextMenu", undefined);
      rightClick(entries[2], 123, 234);
      await waitFor(() => logs.length > 0);
      assert.lengthOf(calls, 8);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[2].id);
      assert.match(
        String(logs.at(-1)![0]),
        /Failed to open selected grid items menu/,
      );

      const logCount = logs.length;
      override("buildItemContextMenu", async () => {
        throw new Error("Menu opener failed");
      });
      const focusAfterFailure = grid.getAttribute("aria-activedescendant");
      rightClick(entries[2], 123, 234);
      await waitFor(() => logs.length > logCount);
      assert.match(String(logs.at(-1)![1]), /Menu opener failed/);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        focusAfterFailure,
      );

      const beforeKeyboardFailure = logs.length;
      press("F10", { shiftKey: true });
      await waitFor(() => logs.length > beforeKeyboardFailure);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        focusAfterFailure,
      );

      override("buildItemContextMenu", async () => {});
      const beforeMissingPopup = logs.length;
      Object.defineProperty(popup, "openPopupAtScreenRect", {
        configurable: true,
        value: undefined,
      });
      rightClick(entries[2], 321, 432);
      await waitFor(() => logs.length > beforeMissingPopup);
      assert.lengthOf(calls, 8);
      assert.deepEqual(pane.getSelectedItems(true), [ids[2]]);
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        focusAfterFailure,
      );
    } finally {
      if (originalBuilder)
        Object.defineProperty(pane, "buildItemContextMenu", originalBuilder);
      else Reflect.deleteProperty(pane, "buildItemContextMenu");
      if (originalOpen)
        Object.defineProperty(popup, "openPopupAtScreenRect", originalOpen);
      else Reflect.deleteProperty(popup, "openPopupAtScreenRect");
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

  it("opens once against the visible tile rectangle without moving after display", async function () {
    const win = Zotero.getMainWindow()!;
    const bridge = new ItemTreeBridge(win);
    const pane = win.ZoteroPane;
    const doc = win.document;
    const originalGet = Object.getOwnPropertyDescriptor(doc, "getElementById");
    const originalBuilder = Object.getOwnPropertyDescriptor(
      pane,
      "buildItemContextMenu",
    );
    const getElementById = doc.getElementById.bind(doc);
    const host = createRendererHost();
    const anchor = doc.createElement("figure");
    host.style.cssText =
      "position: fixed; left: 50px; top: 50px; width: 150px; height: 100px; overflow: hidden";
    anchor.style.cssText = "height: 80px; width: 100px";
    host.append(anchor);
    doc.documentElement.append(host);
    const openings: Array<[string, number, number, number, number, boolean]> =
      [];
    const popup = {
      openPopupAtScreenRect: (
        position: string,
        x: number,
        y: number,
        width: number,
        height: number,
        context: boolean,
      ) => openings.push([position, x, y, width, height, context]),
      moveTo: () => assert.fail("A visible popup must never be moved"),
    };
    try {
      Object.defineProperty(doc, "getElementById", {
        configurable: true,
        value: (id: string) =>
          id === "zotero-itemmenu" ? popup : getElementById(id),
      });
      Object.defineProperty(pane, "buildItemContextMenu", {
        configurable: true,
        value: async () => {},
      });
      await bridge.openSelectedItemsMenu(anchor);
      assert.deepEqual(openings.pop(), [
        "after_start",
        Math.round(win.mozInnerScreenX + anchor.getBoundingClientRect().right),
        Math.round(win.mozInnerScreenY + anchor.getBoundingClientRect().top),
        0,
        Math.round(anchor.getBoundingClientRect().height),
        true,
      ]);

      // Gecko chooses above/below based on the actual built menu size; a
      // clipped tile only offers its visible portion as the anchor rectangle.
      anchor.style.height = "150px";
      await bridge.openSelectedItemsMenu(anchor);
      assert.deepEqual(openings.pop(), [
        "after_start",
        Math.round(win.mozInnerScreenX + anchor.getBoundingClientRect().right),
        Math.round(win.mozInnerScreenY + anchor.getBoundingClientRect().top),
        0,
        Math.round(
          host.getBoundingClientRect().bottom -
            anchor.getBoundingClientRect().top,
        ),
        true,
      ]);
    } finally {
      if (originalGet)
        Object.defineProperty(doc, "getElementById", originalGet);
      else Reflect.deleteProperty(doc, "getElementById");
      if (originalBuilder)
        Object.defineProperty(pane, "buildItemContextMenu", originalBuilder);
      else Reflect.deleteProperty(pane, "buildItemContextMenu");
      host.remove();
      bridge.destroy();
    }
  });

  it("builds the installed Zotero item menu and displays its native popup", async function () {
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
        "Installed Zotero builder populates the native item popup",
      );
    } finally {
      popup.hidePopup();
      popup.removeEventListener("popupshowing", onShowing);
      bridge.destroy();
      await item.eraseTx();
    }
  });
});
