import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import { getPref, setPref } from "../src/utils/prefs";

describe("grid view", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

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
      renderer.setItems([displayItem], { showAuthors: true });
      assert.strictEqual(host.firstElementChild, entry);
    } finally {
      renderer.destroy();
    }
  });

  it("renders tiles in finite chunks and appends the next chunk at the sentinel", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const OriginalIntersectionObserver = win.IntersectionObserver;
    let notify: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "400px") notify = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const items = Array.from(
      { length: 121 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Chunk item ${index}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );
    const renderer = new GridRenderer(host, () => {});

    try {
      renderer.setItems(items, { showAuthors: true });

      const firstChunk = host.querySelectorAll<HTMLElement>(".grid-view-item");
      assert.lengthOf(firstChunk, 120);
      assert.equal(firstChunk[0].dataset.renderIndex, "0");
      assert.equal(firstChunk[119].dataset.renderIndex, "119");
      assert.lengthOf(host.querySelectorAll(".grid-view-sentinel"), 1);
      const sentinel = host.querySelector(".grid-view-sentinel")!;
      notify?.(
        [
          {
            isIntersecting: true,
            target: sentinel,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 121);
      assert.equal(
        host.querySelectorAll<HTMLElement>(".grid-view-item")[120].dataset
          .renderIndex,
        "120",
      );
      assert.lengthOf(host.querySelectorAll(".grid-view-sentinel"), 0);
    } finally {
      renderer.destroy();
      win.IntersectionObserver = OriginalIntersectionObserver;
    }
  });

  it("starts cover loading only when a tile approaches the viewport", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const originalCacheCover = CoverProvider.cacheCover;
    const originalGetCover = CoverProvider.getCover;
    let notify: IntersectionObserverCallback | undefined;
    const cachedItemIDs: number[] = [];
    const requestedItemIDs: number[] = [];

    class FakeIntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "200px") notify = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    CoverProvider.cacheCover = (item) => cachedItemIDs.push(item.id);
    CoverProvider.getCover = (itemID) => {
      requestedItemIDs.push(itemID);
      return Promise.resolve(null);
    };

    const displayItem = {
      id: -1,
      firstCreator: "",
      getDisplayTitle: () => "Lazy cover",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    const renderer = new GridRenderer(host, () => {});

    try {
      renderer.setItems([displayItem], { showAuthors: true });
      assert.isEmpty(cachedItemIDs);
      assert.isEmpty(requestedItemIDs);

      const tile = host.querySelector(".grid-view-item")!;
      notify?.(
        [
          {
            isIntersecting: true,
            target: tile,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      await Promise.resolve();

      assert.deepEqual(cachedItemIDs, [displayItem.id]);
      assert.deepEqual(requestedItemIDs, [displayItem.id]);
    } finally {
      renderer.destroy();
      CoverProvider.cacheCover = originalCacheCover;
      CoverProvider.getCover = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
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

  it("passes a tile double-click to the renderer activation callback", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    let activatedID: number | undefined;
    const renderer = new GridRenderer(
      host,
      () => {},
      (itemID) => {
        activatedID = itemID;
      },
    );
    const displayItem = {
      id: -1,
      getDisplayTitle: () => "Activated item",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], { showAuthors: true });
      host
        .querySelector(".grid-view-cover")!
        .dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      assert.equal(activatedID, displayItem.id);
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
      assert.equal(
        host.querySelector(".grid-view-cover img")?.alt,
        "Cover for Analytical Engine Notes",
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

  it("preserves grid state while a reader tab is active", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    let readerTabID: string | undefined;

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Reader tab refresh test ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.cssText += "; height: 120px; flex: 0 0 120px";
      await pane.selectItems([items[0].id], true);
      await Zotero.Promise.delay(100);
      const firstEntry = grid.querySelector(`[data-item-id="${items[0].id}"]`)!;
      assert.exists(firstEntry);
      assert.isAbove(grid.scrollHeight, grid.clientHeight);
      grid.scrollTop = 50;
      const scrollTop = grid.scrollTop;
      readerTabID = win.Zotero_Tabs.add({
        type: "reader",
        title: "Reader tab refresh test",
        data: { itemID: items[0].id },
        select: true,
      }).id;

      items[0].setField("title", "Reader tab updated title");
      await items[0].saveTx();
      await Zotero.Promise.delay(100);
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${items[0].id}"]`),
        firstEntry,
        "The grid should not render while its tab is hidden",
      );
      win.Zotero_Tabs.select("zotero-pane");
      await Zotero.Promise.delay(100);

      for (const item of items) {
        assert.exists(grid.querySelector(`[data-item-id="${item.id}"]`));
      }
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${items[0].id}"]`),
        firstEntry,
      );
      assert.equal(grid.scrollTop, scrollTop);

      toggle();
      toggle();
      assert.equal(grid.scrollTop, scrollTop);
      assert.equal(
        grid.querySelector(`[data-item-id="${items[0].id}"] .grid-view-title`)
          ?.textContent,
        "Reader tab updated title",
      );
    } finally {
      win.Zotero_Tabs.select("zotero-pane");
      if (readerTabID) win.Zotero_Tabs.close(readerTabID);
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("applies the enableGridView preference and updates it from the toolbar", async function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;
    const originalEnableGridView = getPref("enableGridView");

    try {
      setPref("enableGridView", false);
      await Zotero.Promise.delay(20);
      assert.isTrue(grid.hidden);
      assert.notEqual(win.getComputedStyle(itemTree).display, "none");

      button.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(20);
      assert.isTrue(getPref("enableGridView"));
      assert.isFalse(grid.hidden);
      assert.equal(win.getComputedStyle(itemTree).display, "none");
    } finally {
      setPref("enableGridView", originalEnableGridView);
      await Zotero.Promise.delay(20);
    }
  });

  it("toggles between the cover grid and native item list", function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const noteButton = win.document.getElementById("zotero-tb-note-add")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;
    const icon = () => win.getComputedStyle(button).listStyleImage;

    assert.strictEqual(noteButton.nextElementSibling, button);
    assert.isTrue(button.hasAttribute("checked"));
    assert.include(icon(), "list-view.svg");
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isFalse(button.hasAttribute("checked"));
    assert.include(icon(), "grid-view.svg");
    assert.isTrue(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "none");
    assert.notEqual(itemTree.style.display, "none");
    assert.notEqual(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isTrue(button.hasAttribute("checked"));
    assert.include(icon(), "list-view.svg");
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");
  });
});
