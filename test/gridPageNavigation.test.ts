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
      assert.isTrue(
        condition(),
        `${message}; selected ${selected().join(",")}, focused ${grid.getAttribute("aria-activedescendant")}`,
      );
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
      grid.style.flex = "none";
      grid.style.height = "1200px";
      await waitFor(
        () => grid.querySelectorAll(".grid-view-item").length === 13,
        "Collection tiles rendered",
      );
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const ids = entries.map((entry) => Number(entry.dataset.itemId));
      const tile = (index: number) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${ids[index]}"]`)!;
      const resetScroll = () => {
        grid.scrollTop = 0;
        grid.dispatchEvent(new win.Event("scroll"));
      };
      const rowHeight = entries[3].offsetTop - entries[0].offsetTop;
      assert.isAbove(rowHeight, 0);
      grid.style.flex = "none";
      grid.style.height = `${rowHeight * 2 - 8}px`;
      assert.closeTo(grid.clientHeight, rowHeight * 2 - 8, 2);

      tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => selected()[0] === ids[1], "Starting selection");
      grid.style.height = `${rowHeight * 3.5}px`;
      resetScroll();
      assert.closeTo(grid.clientHeight, rowHeight * 3.5, 2);
      press("PageDown");
      await waitFor(
        () => selected()[0] === ids[10],
        "PageDown reaches the partially visible fourth row",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), tile(10).id);

      // Measure live viewport coordinates rather than extrapolating rounded
      // offsetTop row spacing. Cover layout and padding can change that spacing.
      for (const padding of ["0", ""]) {
        grid.style.padding = padding;
        await Zotero.Promise.delay(20);
        resetScroll();
        const fourthRowTop =
          tile(10).getBoundingClientRect().top -
          grid.getBoundingClientRect().top;
        for (const visiblePixels of [0, 1]) {
          grid.style.height = `${fourthRowTop + visiblePixels}px`;
          resetScroll();
          tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
          await waitFor(() => selected()[0] === ids[1], "Viewport edge start");
          assert.closeTo(
            grid.getBoundingClientRect().bottom -
              tile(10).getBoundingClientRect().top,
            visiblePixels,
            0.05,
            `Exactly ${visiblePixels} pixels of the fourth row are visible (padding ${padding || "default"})`,
          );
          press("PageDown");
          await waitFor(
            () => selected()[0] === ids[visiblePixels ? 10 : 7],
            visiblePixels
              ? "One visible pixel includes the fourth row"
              : "Row starting below viewport is not selected",
          );
        }
      }

      resetScroll();
      grid.style.height = `${(tile(3).offsetTop - tile(0).offsetTop) * 2 - 8}px`;
      tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => selected()[0] === ids[1], "Reset starting selection");
      assert.isTrue(press("PageDown").defaultPrevented);
      await waitFor(
        () => selected()[0] === ids[4],
        "Last visible row in column two",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), tile(4).id);

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

      grid.style.height = `${rowHeight / 2}px`;
      resetScroll();
      tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => selected()[0] === ids[1], "Short viewport start");
      press("PageDown");
      await waitFor(
        () => selected()[0] === ids[4],
        "Short viewport still advances one row",
      );
      assert.isAbove(grid.scrollTop, 0, "Next row scrolls into view");

      grid.style.height = `${rowHeight * 2 - 8}px`;
      resetScroll();
      grid.style.gridTemplateColumns = "repeat(2, 150px)";
      await waitFor(
        () => tile(1).offsetTop !== tile(2).offsetTop,
        "Mounted rows follow changed column styles",
      );
      tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
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
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => {
        commands.push(command);
      },
    );
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

  it("pages to unmounted rows without requesting covers outside the viewport", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const originalCacheCover = CoverProvider.cacheCover;
    const originalGetCover = CoverProvider.getCoverResult;
    const requestedIDs: number[] = [];
    const cachedIDs: number[] = [];
    const observed = new Set<Element>();
    let notifyCover: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "200px") notifyCover = callback;
      }
      observe(target: Element): void {
        if (notifyCover) observed.add(target);
      }
      unobserve(target: Element): void {
        observed.delete(target);
      }
      disconnect(): void {
        observed.clear();
      }
    }
    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    CoverProvider.cacheCover = (item) => {
      cachedIDs.push(item.id);
    };
    CoverProvider.getCoverResult = (id) => {
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
      host.style.gridTemplateColumns = "repeat(3, 150px)";
      host.style.setProperty("--cover-view-tile-size", "150px");
      host.style.alignContent = "start";
      host.style.height = "500px";
      host.style.width = "600px";
      host.style.overflow = "auto";
      win.document.documentElement.append(host);
      renderer.setItems(items, { showCreators: true });
      renderer.setFocusedItem(focusedID);
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 20);
      renderer.setFocusedItem(items[118].id);
      focusedID = items[118].id;
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
        "Destination is in an unvisited row",
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
      const destination = host.querySelector<HTMLElement>(
        `[data-item-id="${focusedID}"]`,
      )!;
      assert.isTrue(observed.has(destination));
      notifyCover?.(
        [
          {
            isIntersecting: true,
            target: destination,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      await Promise.resolve();
      assert.deepEqual(cachedIDs, [focusedID]);
      assert.deepEqual(requestedIDs, [focusedID]);
    } finally {
      renderer.destroy();
      host.remove();
      CoverProvider.cacheCover = originalCacheCover;
      CoverProvider.getCoverResult = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
    }
  });
});
