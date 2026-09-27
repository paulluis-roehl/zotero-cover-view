import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";

describe("grid page navigation", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("pages through live rows, preserves the visual column, and extends anchored selection", async function () {
    this.timeout(120000);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originalStyle = grid.style.cssText;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const items: Zotero.Item[] = [];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const selected = () => pane.getSelectedItems(true);
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), message);
    };
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

    try {
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      collection.name = `Page navigation ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      for (let index = 0; index < 13; index++) {
        const item = new Zotero.Item("book");
        item.setField(
          "title",
          `Page navigation ${collection.id} ${String(index).padStart(2, "0")}`,
        );
        item.addToCollection(collection.id);
        await item.saveTx();
        items.push(item);
      }
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      await waitFor(
        () => pane.getSelectedCollection(true) === collection.id,
        "New collection selected",
      );
      if (grid.hidden) toggle();
      grid.style.gridTemplateColumns = "repeat(3, 150px)";
      await waitFor(
        () => grid.querySelectorAll(".grid-view-item").length === 13,
        "Collection tiles rendered",
      );
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const ids = entries.map((entry) => Number(entry.dataset.itemId));
      const rowHeight = entries[3].offsetTop - entries[0].offsetTop;
      assert.isAbove(rowHeight, 0);
      grid.style.flex = "none";
      grid.style.height = `${rowHeight * 2}px`;
      assert.closeTo(grid.clientHeight, rowHeight * 2, 2);

      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => selected()[0] === ids[1], "Starting selection");
      grid.style.height = `${rowHeight * 3.5}px`;
      assert.closeTo(grid.clientHeight, rowHeight * 3.5, 2);
      press("PageDown");
      await waitFor(
        () => selected()[0] === ids[10],
        "PageDown reaches the partially visible fourth row",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[10].id);

      grid.style.height = `${rowHeight * 2}px`;
      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => selected()[0] === ids[1], "Reset starting selection");
      assert.isTrue(press("PageDown").defaultPrevented);
      await waitFor(
        () => selected()[0] === ids[4],
        "Last visible row in column two",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[4].id);

      press("PageDown", { shiftKey: true });
      await waitFor(
        () => selected().length === 4,
        "Shift extends from the new anchor",
      );
      assert.deepEqual(selected(), ids.slice(4, 8));
      assert.isAbove(grid.scrollTop, 0, "Destination scrolled into view");
      press("PageDown", { shiftKey: true });
      await waitFor(
        () => selected().length === 7,
        "Continue the anchored range",
      );
      assert.deepEqual(selected(), ids.slice(4, 11));
      press("PageDown", { shiftKey: true });
      await waitFor(
        () => selected().length === 9,
        "Reach incomplete final row",
      );
      assert.deepEqual(
        selected(),
        ids.slice(4, 13),
        "Incomplete final row clamps to last tile",
      );
      press("PageDown", { shiftKey: true });
      assert.deepEqual(
        selected(),
        ids.slice(4, 13),
        "Final boundary remains selected",
      );
      press("PageUp", { shiftKey: true });
      await waitFor(
        () => selected().length === 6,
        "Shift contracts toward anchor",
      );
      assert.deepEqual(selected(), ids.slice(4, 10));

      grid.style.gridTemplateColumns = "repeat(2, 150px)";
      assert.notEqual(entries[1].offsetTop, entries[2].offsetTop);
      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => selected()[0] === ids[1] && selected().length === 1,
        "Reflow starting tile",
      );
      press("PageDown");
      await waitFor(
        () => selected()[0] === ids[3],
        "Reflow changes page destination",
      );
      press("PageUp");
      await waitFor(
        () => selected()[0] === ids[1],
        "PageUp returns to starting column",
      );
      press("PageUp");
      assert.deepEqual(selected(), [ids[1]], "First boundary clamps");

    } finally {
      grid.style.cssText = originalStyle;
      if (grid.hidden !== originallyHidden) toggle();
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of items) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("leaves Ctrl/Cmd page shortcuts, including Shift, unhandled", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const commands: string[] = [];
    const renderer = new GridRenderer(host, () => {}, undefined, (command) => {
      commands.push(command);
    });
    try {
      for (const modifiers of [
        { ctrlKey: true },
        { metaKey: true },
        { ctrlKey: true, shiftKey: true },
        { metaKey: true, shiftKey: true },
      ]) {
        for (const key of ["PageUp", "PageDown"]) {
          const event = new win.KeyboardEvent("keydown", {
            key,
            cancelable: true,
            ...modifiers,
          });
          host.dispatchEvent(event);
          assert.isFalse(event.defaultPrevented, `${key} left to Zotero`);
        }
      }
      assert.isEmpty(commands);
    } finally {
      renderer.destroy();
    }
  });

  it("pages across rendering chunks without requesting covers outside the viewport", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const originalGetCover = CoverProvider.getCover;
    const requestedIDs: number[] = [];
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
    CoverProvider.getCover = (id) => {
      requestedIDs.push(id);
      return Promise.resolve(null);
    };
    const items = Array.from(
      { length: 361 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Page item ${index}`,
        }) as Zotero.Item,
    );
    let focusedID = items[1].id;
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => {
        if (command !== "page-down" && command !== "page-up") return;
        focusedID = renderer.getPageDestination(
          focusedID,
          command === "page-down" ? 1 : -1,
        )!;
        renderer.setFocusedItem(focusedID, true);
      },
    );
    try {
      host.style.display = "grid";
      host.style.gridTemplateColumns = "repeat(120, 5px)";
      host.style.alignContent = "start";
      host.style.height = "500px";
      host.style.width = "600px";
      host.style.overflow = "auto";
      win.document.documentElement.append(host);
      renderer.setItems(items, { showAuthors: true });
      renderer.setFocusedItem(focusedID);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 120);
      const page = new win.KeyboardEvent("keydown", {
        key: "PageDown",
        bubbles: true,
        cancelable: true,
      });
      host.dispatchEvent(page);
      assert.isTrue(page.defaultPrevented);
      assert.isAbove(
        Math.abs(focusedID),
        120,
        "Destination exceeds initial chunk",
      );
      assert.isAtMost(Math.abs(focusedID), 361);
      assert.equal(
        host.getAttribute("aria-activedescendant"),
        host.querySelector<HTMLElement>(`[data-item-id="${focusedID}"]`)!.id,
      );
      assert.isEmpty(
        requestedIDs,
        "Rendering skipped tiles does not load their covers",
      );
    } finally {
      renderer.destroy();
      host.remove();
      CoverProvider.getCover = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
    }
  });
});
