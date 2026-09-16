import { assert } from "chai";
import { GridRenderer } from "../src/modules/gridRenderer";
import { getPref, setPref } from "../src/utils/prefs";

describe("grid view", function () {
  it("restores visible native rows after scrolling the hidden list", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items: Zotero.Item[] = [];
    const toggle = () => button.dispatchEvent(new win.Event("command"));

    try {
      for (let index = 0; index < 8; index++) {
        const item = new Zotero.Item("book");
        item.setField("title", `Hidden list layout test ${index}`);
        await item.saveTx();
        items.push(item);
      }
      if (grid.hidden) toggle();
      await pane.selectItems([items[0].id], true);
      if (!pane.itemsView) throw new Error("Native item view is unavailable");
      const list = pane.itemsView._treebox;

      // Native selection can scroll this list while its ancestor is display:none.
      // Reproduce the resulting mismatch between its cache and the DOM offset.
      list.scrollTo(4 * list.itemHeight);
      assert.isAbove(list.scrollOffset, list.targetElement.scrollTop);

      toggle();
      assert.isAbove(list.getWindowHeight(), 0);
      assert.equal(list.scrollOffset, list.targetElement.scrollTop);
      const first = list.getFirstVisibleRow();
      const last = Math.min(
        list.getLastVisibleRow(),
        pane.itemsView.rowCount - 1,
      );
      for (let index = first; index <= last; index++) {
        const row = list.getElementByIndex(index);
        assert.exists(row, `Visible native row ${index} must be rendered`);
        assert.isNotEmpty(row.textContent.trim());
      }
      assert.deepEqual(pane.getSelectedItems(true), [items[0].id]);
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) await item.eraseTx();
    }
  });

  it("displays native selection when switching from the tree to the grid", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const selectedIDs = () =>
      Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item.selected"),
      ).map((entry) => Number(entry.dataset.itemId));

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid selection test ${index}`);
        await item.saveTx();
      }
      if (!grid.hidden) toggle();
      await pane.selectItems([items[0].id], true);
      toggle();
      assert.deepEqual(selectedIDs(), [items[0].id]);

      const selected = grid.querySelector<HTMLElement>(
        ".grid-view-item.selected",
      )!;
      assert.notEqual(
        win.getComputedStyle(selected).backgroundColor,
        "rgba(0, 0, 0, 0)",
      );

      toggle();
      await pane.selectItems([items[1].id], true);
      toggle();
      assert.deepEqual(selectedIDs(), [items[1].id]);

      toggle();
      if (!pane.itemsView) throw new Error("Native item view is unavailable");
      pane.itemsView.selection.clearSelection();
      toggle();
      assert.isEmpty(selectedIDs());
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("updates selection without replacing tiles and ignores undisplayed IDs", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    item.setField("title", "Selection presentation");
    // A display-only item avoids database notifications during this renderer test.
    const displayItem = {
      id: -1,
      getDisplayTitle: () => item.getDisplayTitle(),
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    try {
      renderer.setItems([displayItem], { showAuthors: true });
      const entry = host.firstElementChild!;
      renderer.setSelection([-1, -2]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isTrue(entry.classList.contains("selected"));
      renderer.setSelection([]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isFalse(entry.classList.contains("selected"));
    } finally {
      renderer.destroy();
    }
  });

  it("passes a tile click to the renderer selection callback", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    let selectedID: number | undefined;
    const renderer = new GridRenderer(host, (itemID) => {
      selectedID = itemID;
    });
    const displayItem = {
      id: -1,
      getDisplayTitle: () => "Clicked item",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], { showAuthors: true });
      host
        .querySelector(".grid-view-cover")!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      assert.equal(selectedID, displayItem.id);
    } finally {
      renderer.destroy();
    }
  });

  it("renders the title and authors on separate caption lines", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const displayItem = {
      id: -1,
      firstCreator: "Ada Lovelace and Charles Babbage",
      getDisplayTitle: () => "Analytical Engine Notes",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], { showAuthors: true });
      assert.equal(
        host.querySelector(".grid-view-title")?.textContent,
        "Analytical Engine Notes",
      );
      assert.equal(
        host.querySelector(".grid-view-authors")?.textContent,
        "Ada Lovelace and Charles Babbage",
      );

      renderer.setItems([displayItem], { showAuthors: false });
      assert.notExists(host.querySelector(".grid-view-authors"));
    } finally {
      renderer.destroy();
    }
  });

  it("refreshes automatically on preference changes and applies changes made in list mode", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const originalShowAuthors = getPref("showAuthors");
    const originallyHidden = grid.hidden;
    const item = new Zotero.Item("book");
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const authorLine = () =>
      grid.querySelector(`[data-item-id="${item.id}"] .grid-view-authors`);
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), "Grid should reflect the changed preference");
    };

    try {
      item.setField("title", "Preference refresh test");
      item.setCreators([
        { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
      ]);
      await item.saveTx();
      setPref("showAuthors", true);
      if (grid.hidden) toggle();
      await pane.selectItems([item.id], true);
      await waitFor(() => !!authorLine());

      setPref("showAuthors", false);
      await waitFor(() => !authorLine());
      assert.exists(grid.querySelector(`[data-item-id="${item.id}"]`));
      setPref("showAuthors", true);
      await waitFor(() => !!authorLine());

      toggle();
      const previousTile = grid.querySelector(`[data-item-id="${item.id}"]`);
      setPref("showAuthors", false);
      await Zotero.Promise.delay(100);
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${item.id}"]`),
        previousTile,
      );
      toggle();
      assert.notExists(authorLine());
      assert.exists(grid.querySelector(`[data-item-id="${item.id}"].selected`));
    } finally {
      setPref("showAuthors", originalShowAuthors);
      if (grid.hidden !== originallyHidden) toggle();
      if (item.id) await item.eraseTx();
    }
  });

  it("selects the native item when a grid tile is clicked", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const item = new Zotero.Item("book");
    const toggle = () => button.dispatchEvent(new win.Event("command"));

    try {
      item.setField("title", "Grid click selection test");
      await item.saveTx();
      if (!grid.hidden) toggle();
      toggle();

      const entry = grid.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      assert.exists(entry);
      entry.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => win.setTimeout(resolve, 100));

      assert.deepEqual(pane.getSelectedItems(true), [item.id]);
      assert.isTrue(entry.classList.contains("selected"));
    } finally {
      if (grid.hidden) toggle();
      if (item.id) await item.eraseTx();
    }
  });

  it("toggles between the cover grid and native item list", function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;

    assert.isTrue(button.hasAttribute("checked"));
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isFalse(button.hasAttribute("checked"));
    assert.isTrue(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "none");
    assert.notEqual(itemTree.style.display, "none");
    assert.notEqual(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isTrue(button.hasAttribute("checked"));
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");
  });
});
