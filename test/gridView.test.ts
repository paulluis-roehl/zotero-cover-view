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
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      const entry = host.firstElementChild!;
      renderer.setSelection([-1, -2]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isTrue(entry.classList.contains("selected"));
      renderer.setSelection([]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isFalse(entry.classList.contains("selected"));
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      assert.strictEqual(host.firstElementChild, entry);
    } finally {
      renderer.destroy();
    }
  });

  it("exposes one focusable listbox with independently focused options", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const items = [-1, -2].map(
      (id) =>
        ({
          id,
          firstCreator: "",
          getDisplayTitle: () => `Accessible item ${id}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );

    try {
      renderer.setItems(items, { showAuthors: true });
      renderer.setSelection([-1]);
      renderer.setFocusedItem(-2);

      const [selected, focused] = Array.from(
        host.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.equal(host.tabIndex, 0);
      assert.equal(host.getAttribute("role"), "listbox");
      assert.equal(host.getAttribute("aria-multiselectable"), "true");
      assert.notExists(selected.getAttribute("tabindex"));
      assert.notExists(focused.getAttribute("tabindex"));
      assert.equal(selected.getAttribute("role"), "option");
      assert.equal(selected.getAttribute("aria-selected"), "true");
      assert.equal(focused.getAttribute("aria-selected"), "false");
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.isTrue(focused.classList.contains("focused"));
      assert.isFalse(selected.classList.contains("focused"));
    } finally {
      renderer.destroy();
    }
  });

  it("handles only unmodified grid navigation keys", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const commands: string[] = [];
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => commands.push(String(command)),
    );

    try {
      const left = new win.KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      });
      const right = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      const up = new win.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      const down = new win.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      const home = new win.KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      });
      const end = new win.KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      });
      const modified = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      const unrelated = new win.KeyboardEvent("keydown", {
        key: "r",
        bubbles: true,
        cancelable: true,
      });

      host.dispatchEvent(left);
      host.dispatchEvent(right);
      host.dispatchEvent(up);
      host.dispatchEvent(down);
      host.dispatchEvent(home);
      host.dispatchEvent(end);
      host.dispatchEvent(modified);
      host.dispatchEvent(unrelated);

      assert.deepEqual(commands, [
        "left",
        "right",
        "up",
        "down",
        "home",
        "end",
      ]);
      assert.isTrue(left.defaultPrevented);
      assert.isTrue(right.defaultPrevented);
      assert.isTrue(up.defaultPrevented);
      assert.isTrue(down.defaultPrevented);
      assert.isTrue(home.defaultPrevented);
      assert.isTrue(end.defaultPrevented);
      assert.isFalse(modified.defaultPrevented);
      assert.isFalse(unrelated.defaultPrevented);
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
      renderer.setItems(items, {
        showAuthors: true,
        fetchISBNCover: false,
      });

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
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
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
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
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
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
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
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
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

      renderer.setItems([displayItem], {
        showAuthors: false,
        fetchISBNCover: false,
      });
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

  it("selects and focuses a grid tile when it is clicked", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid click selection test ${index}`);
        await item.saveTx();
      }
      if (!grid.hidden) toggle();
      toggle();

      const firstEntry = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[0].id}"]`,
      )!;
      const clickedEntry = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[1].id}"]`,
      )!;
      assert.exists(firstEntry);
      assert.exists(clickedEntry);
      await pane.selectItems([items[0].id], true);
      grid.blur();
      grid.focus();
      grid.dispatchEvent(new win.FocusEvent("focus"));
      assert.equal(grid.getAttribute("aria-activedescendant"), firstEntry.id);

      clickedEntry.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true }),
      );
      await new Promise((resolve) => win.setTimeout(resolve, 100));

      assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
      assert.strictEqual(win.document.activeElement, grid);
      assert.equal(grid.getAttribute("aria-activedescendant"), clickedEntry.id);
      assert.isTrue(clickedEntry.classList.contains("focused"));
      assert.isTrue(clickedEntry.classList.contains("selected"));
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates displayed items horizontally through the focused grid host", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), message);
    };

    try {
      await waitFor(
        () => !grid.querySelector(".grid-view-item"),
        "Previous grid items should be removed before navigation setup",
      );
      const titlePrefix = `Keyboard navigation ${Date.now()}`;
      for (const [index, item] of items.entries()) {
        item.setField("title", `${titlePrefix} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.gridTemplateColumns = "150px";
      await waitFor(() => {
        const renderedIDs = Array.from(
          grid.querySelectorAll<HTMLElement>(".grid-view-item"),
        ).map((entry) => Number(entry.dataset.itemId));
        return (
          renderedIDs.length === items.length &&
          items.every((item) => renderedIDs.includes(item.id))
        );
      }, "New items should be rendered in the grid");

      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.isAtLeast(entries.length, 2);
      const sourceIndex = entries.length - 2;
      const source = entries[sourceIndex];
      const destination = entries[sourceIndex + 1];
      assert.notEqual(
        source.offsetTop,
        destination.offsetTop,
        "The adjacent items should cross a visual row boundary",
      );
      const destinationID = Number(destination.dataset.itemId);
      let scrollOptions: ScrollIntoViewOptions | undefined;
      const originalScrollIntoView = destination.scrollIntoView;
      destination.scrollIntoView = (
        options?: boolean | ScrollIntoViewOptions,
      ) => {
        if (typeof options === "object") scrollOptions = options;
      };

      grid.blur();
      source.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(source.dataset.itemId),
        "Click should establish the keyboard navigation start",
      );
      assert.strictEqual(win.document.activeElement, grid);
      assert.equal(grid.getAttribute("role"), "listbox");
      assert.equal(grid.getAttribute("aria-multiselectable"), "true");
      assert.equal(grid.getAttribute("aria-activedescendant"), source.id);

      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(
        () => pane.getSelectedItems(true)[0] === destinationID,
        "Right Arrow should update Zotero's selection",
      );

      assert.equal(grid.getAttribute("aria-activedescendant"), destination.id);
      assert.equal(destination.getAttribute("aria-selected"), "true");
      assert.notEqual(win.getComputedStyle(destination).outlineStyle, "dotted");
      assert.deepEqual(scrollOptions, { block: "nearest", inline: "nearest" });

      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(20);
      assert.equal(grid.getAttribute("aria-activedescendant"), destination.id);
      assert.deepEqual(pane.getSelectedItems(true), [destinationID]);

      for (let index = sourceIndex; index >= 0; index--) {
        const expected = entries[index];
        grid.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "ArrowLeft",
            bubbles: true,
            cancelable: true,
          }),
        );
        await waitFor(
          () =>
            pane.getSelectedItems(true)[0] === Number(expected.dataset.itemId),
          "Left Arrow should select each preceding displayed item",
        );
        assert.equal(grid.getAttribute("aria-activedescendant"), expected.id);
      }
      const first = entries[0];
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(20);
      assert.equal(grid.getAttribute("aria-activedescendant"), first.id);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(first.dataset.itemId),
      ]);

      for (let index = 1; index <= sourceIndex + 1; index++) {
        const expected = entries[index];
        grid.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
        await waitFor(
          () =>
            pane.getSelectedItems(true)[0] === Number(expected.dataset.itemId),
          "Right Arrow should select each following displayed item",
        );
      }
      destination.scrollIntoView = originalScrollIntoView;
    } finally {
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates adjacent visual rows and follows responsive reflow", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = Array.from({ length: 7 }, () => new Zotero.Item("book"));
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    const press = (key: string) =>
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    const waitForSelection = async (itemID: number) => {
      const deadline = Date.now() + 2000;
      while (
        pane.getSelectedItems(true)[0] !== itemID &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(20);
      }
      assert.deepEqual(pane.getSelectedItems(true), [itemID]);
    };

    try {
      const titlePrefix = `Spatial navigation ${Date.now()}`;
      for (const [index, item] of items.entries()) {
        item.setField("title", `${titlePrefix} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.gridTemplateColumns = "repeat(3, 150px)";

      const deadline = Date.now() + 2000;
      while (
        !items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ) &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(20);
      }
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.lengthOf(entries, 7);
      assert.equal(entries[0].offsetTop, entries[2].offsetTop);
      assert.notEqual(entries[2].offsetTop, entries[3].offsetTop);

      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[4].dataset.itemId));
      press("ArrowUp");
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowUp");
      await Zotero.Promise.delay(20);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(entries[1].dataset.itemId),
      ]);

      entries[5].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[5].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[6].dataset.itemId));
      press("ArrowDown");
      await Zotero.Promise.delay(20);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(entries[6].dataset.itemId),
      ]);

      grid.style.gridTemplateColumns = "repeat(2, 150px)";
      assert.equal(entries[0].offsetTop, entries[1].offsetTop);
      assert.notEqual(entries[1].offsetTop, entries[2].offsetTop);
      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[3].dataset.itemId));

      press("Home");
      await waitForSelection(Number(entries[0].dataset.itemId));
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[0].id);
      press("End");
      await waitForSelection(Number(entries[6].dataset.itemId));
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[6].id);
    } finally {
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates Home and End while preserving finite lazy rendering", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const requestedItemIDs: number[] = [];
    const originalGetCover = CoverProvider.getCover;

    class FakeIntersectionObserver {
      constructor(
        _callback: IntersectionObserverCallback,
        _options?: IntersectionObserverInit,
      ) {}
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    CoverProvider.getCover = (itemID) => {
      requestedItemIDs.push(itemID);
      return Promise.resolve(null);
    };

    const items = Array.from(
      { length: 241 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Endpoint item ${index}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );
    let focusedID = items[117].id;
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => {
        const destinationID =
          command === "home"
            ? items[0].id
            : command === "end"
              ? items.at(-1)!.id
              : command === "down"
                ? renderer.getVerticalDestination(focusedID, 1)
                : undefined;
        if (destinationID === undefined) return;
        focusedID = destinationID;
        renderer.setFocusedItem(focusedID, true);
      },
    );

    try {
      host.style.display = "grid";
      host.style.gridTemplateColumns = "repeat(3, 150px)";
      win.document
        .getElementById("cover-view-grid")!
        .parentElement!.append(host);
      renderer.setItems(items, { showAuthors: true });
      renderer.setFocusedItem(focusedID);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 120);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items[120].id);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 240);
      assert.isEmpty(requestedItemIDs);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items.at(-1)!.id);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 241);
      assert.equal(
        host.getAttribute("aria-activedescendant"),
        host.querySelector<HTMLElement>(`[data-item-id="${focusedID}"]`)!.id,
      );
      assert.isEmpty(requestedItemIDs);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items[0].id);
      assert.isEmpty(requestedItemIDs);
    } finally {
      renderer.destroy();
      host.remove();
      CoverProvider.getCover = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("keeps an empty grid focusable and ignores horizontal navigation", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const deadline = Date.now() + 2000;
    while (grid.querySelector(".grid-view-item") && Date.now() < deadline) {
      await Zotero.Promise.delay(20);
    }
    assert.notExists(grid.querySelector(".grid-view-item"));

    grid.blur();
    grid.focus();
    grid.dispatchEvent(new win.FocusEvent("focus"));
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    assert.strictEqual(win.document.activeElement, grid);
    assert.equal(grid.getAttribute("role"), "listbox");
    assert.notExists(grid.getAttribute("aria-activedescendant"));
    assert.isEmpty(pane.getSelectedItems(true));
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
