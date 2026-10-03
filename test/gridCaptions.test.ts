import { assert } from "chai";
import { GridRenderer } from "../src/modules/gridRenderer";
import { clearPref, getPref, setPref } from "../src/utils/prefs";
import { config } from "../package.json";

describe("independent tile captions", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("independently shows title, creator, and year in all eight combinations", async function () {
    const host = Zotero.getMainWindow()!.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    item.setField("title", "Analytical Engine Notes");
    item.setField("date", "1843-08-01");
    item.setCreators([
      { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
    ]);
    try {
      await item.saveTx();
      for (const showTitles of [true, false]) {
        for (const showCreators of [true, false]) {
          for (const showYears of [true, false]) {
            renderer.setItems([item], { showTitles, showCreators, showYears });
            assert.equal(
              host.querySelector(".grid-view-title")?.textContent ?? "",
              showTitles ? "Analytical Engine Notes" : "",
            );
            const line = host.querySelector<HTMLElement>(".grid-view-metadata");
            const expected = showCreators
              ? showYears
                ? "Lovelace · 1843"
                : "Lovelace"
              : showYears
                ? "1843"
                : "";
            assert.equal(line?.textContent ?? "", expected);
            if (line) assert.equal(line.title, expected);
            assert.equal(
              host.querySelector("img")?.alt,
              "Cover for Analytical Engine Notes",
            );
            assert.equal(
              host.querySelectorAll("figcaption").length,
              showTitles || showCreators || showYears ? 1 : 0,
            );
          }
        }
      }
    } finally {
      renderer.destroy();
      if (item.id) await item.eraseTx();
    }
  });

  it("keeps the cover, selection, focus, and tile identity when captions change", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    item.setField("title", "Unchanged cover text");
    item.setField("date", "2020");
    try {
      await item.saveTx();
      renderer.setItems([item], { showCreators: true });
      renderer.setSelection([item.id]);
      renderer.setFocusedItem(item.id);
      const tile = host.firstElementChild!;
      const image = tile.querySelector("img")!;
      image.src =
        "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text>Unchanged cover text</text></svg>";
      const source = image.src;
      renderer.setItems([item], {
        showTitles: false,
        showCreators: false,
        showYears: false,
      });
      assert.strictEqual(host.firstElementChild, tile);
      assert.strictEqual(tile.querySelector("img"), image);
      assert.equal(image.src, source);
      assert.equal(tile.getAttribute("aria-label"), "Unchanged cover text");
      assert.equal(tile.getAttribute("aria-selected"), "true");
      assert.equal(host.getAttribute("aria-activedescendant"), tile.id);
      assert.notExists(tile.querySelector("figcaption"));
    } finally {
      renderer.destroy();
      if (item.id) await item.eraseTx();
    }
  });

  it("keeps a long creator and the readable year on the same styled line at small tile sizes", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const keys = [
      "showTitles",
      "showCreators",
      "showYears",
      "enableGridView",
      "tileSize",
    ] as const;
    const saved = keys.map((key) => getPref(key));
    const item = new Zotero.Item("book");
    item.setField("title", "Caption layout");
    item.setField("date", "2024");
    item.setCreators([
      {
        lastName:
          "A very long institutional creator whose name cannot fit on a small tile",
        fieldMode: 1,
        creatorType: "author",
      },
    ]);
    try {
      for (const key of keys.slice(0, 4)) setPref(key, true);
      setPref("tileSize", 90);
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      const deadline = Date.now() + 3000;
      while (
        !grid.querySelector(`[data-item-id="${item.id}"] .grid-view-year`) &&
        Date.now() < deadline
      )
        await Zotero.Promise.delay(20);
      const tile = grid.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      assert.exists(tile);
      const creator = tile.querySelector<HTMLElement>(".grid-view-authors")!;
      const year = tile.querySelector<HTMLElement>(".grid-view-year")!;
      assert.exists(year);
      assert.equal(
        creator.getBoundingClientRect().top,
        year.getBoundingClientRect().top,
      );
      assert.equal(
        win.getComputedStyle(creator).fontSize,
        win.getComputedStyle(year).fontSize,
      );
      assert.equal(
        win.getComputedStyle(creator).color,
        win.getComputedStyle(year).color,
      );
      assert.isAbove(
        creator.scrollWidth,
        creator.clientWidth,
        "Creator is truncated",
      );
      assert.isAtMost(
        year.scrollWidth,
        year.clientWidth,
        "Year is fully readable",
      );
      assert.equal(year.textContent, "2024");
      assert.equal(creator.parentElement!.title, `${item.firstCreator} · 2024`);
    } finally {
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (item.id) await item.eraseTx();
    }
  });

  it("omits missing caption fields and uses normalized native years, including early and unknown years", function () {
    const host = Zotero.getMainWindow()!.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    const cases = [
      ["2020-05-12", "2020"],
      ["May 12, 2020", "2020"],
      ["0044-03-15", "44"],
      ["0999-01-01", "999"],
      ["0000-05-12", ""],
      ["forthcoming", ""],
      ["", ""],
    ];
    try {
      for (const [date, expected] of cases) {
        item.setField("date", date);
        renderer.setItems([item], { showCreators: true });
        assert.notExists(host.querySelector(".grid-view-title"));
        assert.notExists(host.querySelector(".grid-view-authors"));
        assert.notExists(host.querySelector(".grid-view-separator"));
        assert.equal(
          host.querySelector(".grid-view-year")?.textContent ?? "",
          expected,
          date,
        );
        assert.equal(
          host.querySelectorAll("figcaption").length,
          expected ? 1 : 0,
        );
      }
      const titleItem = new Zotero.Item("book");
      titleItem.setField("title", "Title only");
      renderer.setItems([titleItem], { showCreators: true });
      assert.equal(host.querySelector("figcaption")?.textContent, "Title only");
      assert.notExists(host.querySelector(".grid-view-metadata"));
    } finally {
      renderer.destroy();
    }
  });

  it("uses Zotero's primary creator summary for directors, artists, and editors", async function () {
    const host = Zotero.getMainWindow()!.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const items: Zotero.Item[] = [];
    try {
      for (const [type, role, name] of [
        ["film", "director", "Varda"],
        ["artwork", "artist", "Kahlo"],
        ["book", "editor", "Babbage"],
      ]) {
        const item = new Zotero.Item(type);
        items.push(item);
        item.setCreators([{ lastName: name, creatorType: role }]);
        await item.saveTx();
        renderer.setItems([item], { showCreators: true });
        assert.equal(
          host.querySelector(".grid-view-authors")?.textContent,
          name,
        );
        assert.equal(
          host.querySelector(".grid-view-metadata")?.textContent,
          item.firstCreator,
        );
        assert.notExists(host.querySelector(".grid-view-separator"));
      }
    } finally {
      renderer.destroy();
      for (const item of items) if (item.id) await item.eraseTx();
    }
  });

  it("defaults all captions on", function () {
    const keys = ["showCreators", "showTitles", "showYears"] as const;
    const saved = keys.map((key) => {
      const pref = `${config.prefsPrefix}.${key}`;
      return {
        hasUserValue: Zotero.Prefs.rootBranch.prefHasUserValue(pref),
        value: Zotero.Prefs.get(pref, true),
      };
    });
    try {
      keys.forEach(clearPref);
      assert.isTrue(getPref("showTitles"));
      assert.isTrue(getPref("showCreators"));
      assert.isTrue(getPref("showYears"));
    } finally {
      keys.forEach((key, index) => {
        clearPref(key);
        if (saved[index].hasUserValue)
          Zotero.Prefs.set(
            `${config.prefsPrefix}.${key}`,
            saved[index].value!,
            true,
          );
      });
    }
  });

  it("updates caption choices live in every grid window without disturbing native selection or navigation", async function () {
    this.timeout(15000);
    const first = Zotero.getMainWindow()!;
    const existingWindows = new Set(Zotero.getMainWindows());
    const keys = [
      "showTitles",
      "showCreators",
      "showYears",
      "enableGridView",
    ] as const;
    const saved = keys.map((key) => getPref(key));
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    let second: _ZoteroTypes.MainWindow | undefined;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 6000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(
        condition(),
        `${message}: ${Zotero.getMainWindows()
          .map(
            (win) =>
              `${win.location.href}, grid=${!!win.document.getElementById("cover-view-grid")}, tree=${!!win.ZoteroPane?.itemsView}`,
          )
          .join("; ")}`,
      );
    };
    try {
      keys.forEach((key) => setPref(key, true));
      for (const [index, item] of items.entries()) {
        item.setField("title", `Live captions ${index}`);
        item.setField("date", "2021");
        item.setCreators([{ lastName: "Varda", creatorType: "author" }]);
        await item.saveTx();
      }
      Zotero.openMainWindow();
      await waitFor(() => {
        second = Zotero.getMainWindows().find(
          (win) => !existingWindows.has(win),
        );
        return (
          !!second?.ZoteroPane?.itemsView && !!second.ZoteroPane.collectionsView
        );
      }, "Second native item tree is ready");
      // The scaffold's temporary add-on does not dispatch new-window hooks.
      // Exercise the plugin's public lifecycle entry point on the real window.
      Zotero.CoverView.hooks.onMainWindowLoad(second!);
      const windows = [first, second!];
      for (const win of windows) {
        await win.ZoteroPane.selectItems([items[0].id], true);
      }
      const grids = windows.map((win) =>
        win.document.getElementById("cover-view-grid")!,
      );
      const tile = (grid: HTMLElement) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${items[0].id}"]`)!;
      await waitFor(
        () =>
          grids.every((grid) => !!tile(grid)?.querySelector(".grid-view-year")),
        "Both windows display initial captions",
      );
      const originalTiles = grids.map(tile);
      const originalImages = originalTiles.map((entry) =>
        entry.querySelector("img"),
      );
      const focus = grids.map((grid) =>
        grid.getAttribute("aria-activedescendant"),
      );
      for (const key of ["showTitles", "showCreators", "showYears"] as const) {
        const selector = {
          showTitles: ".grid-view-title",
          showCreators: ".grid-view-authors",
          showYears: ".grid-view-year",
        }[key];
        setPref(key, false);
        await waitFor(
          () => grids.every((grid) => !tile(grid).querySelector(selector)),
          `${key} disappears everywhere`,
        );
        setPref(key, true);
        await waitFor(
          () => grids.every((grid) => !!tile(grid).querySelector(selector)),
          `${key} returns everywhere`,
        );
      }
      for (const [index, grid] of grids.entries()) {
        assert.strictEqual(tile(grid), originalTiles[index]);
        assert.strictEqual(
          tile(grid).querySelector("img"),
          originalImages[index],
        );
        assert.deepEqual(windows[index].ZoteroPane.getSelectedItems(true), [
          items[0].id,
        ]);
        assert.equal(grid.getAttribute("aria-activedescendant"), focus[index]);
      }
      first.document.getElementById("cover-view-grid")!.dispatchEvent(
        new first.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(
        () => first.ZoteroPane.getSelectedItems(true)[0] === items[1].id,
        "Navigation still uses native item order",
      );
    } finally {
      const opened =
        second ??
        Zotero.getMainWindows().find((win) => !existingWindows.has(win));
      if (opened) {
        Zotero.CoverView.hooks.onMainWindowUnload(opened);
        opened.close();
      }
      keys.forEach((key, index) => setPref(key, saved[index]));
      for (const item of items) if (item.id) await item.eraseTx();
    }
  });
});
