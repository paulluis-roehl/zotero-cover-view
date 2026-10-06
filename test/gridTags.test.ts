import { assert } from "chai";
import { createRendererHost } from "./helpers/rendererHost";
import { GridRenderer } from "../src/modules/gridRenderer";
import { getPref, setPref } from "../src/utils/prefs";

async function waitFor(
  check: () => boolean,
  message = "Grid presentation became current",
): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(check(), message);
}

describe("native grid tag indicators", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("shows coloured and emoji tags in native order with tag-name tooltips", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", "Tagged title");
    item.setTags([
      { tag: "cv-test-red" },
      { tag: "cv-test-blue" },
      { tag: "⭐ Read" },
      { tag: "ordinary text" },
    ]);
    try {
      await Zotero.Tags.setColor(item.libraryID, "cv-test-blue", "#0000ff", 0);
      await Zotero.Tags.setColor(item.libraryID, "cv-test-red", "#ff0000", 1);
      renderer.setItems([item], { showCreators: false });
      const indicators = Array.from(
        host.querySelectorAll<HTMLElement>(".grid-view-tag"),
      );
      assert.deepEqual(
        indicators.map((node) => node.title),
        ["cv-test-blue", "cv-test-red", "⭐ Read"],
      );
      assert.equal(indicators[0].style.color, "rgb(0, 0, 255)");
      assert.equal(indicators[2].textContent, "⭐");
      assert.equal(
        host.querySelector(".grid-view-title")!.textContent,
        "Tagged title",
      );
    } finally {
      renderer.destroy();
      await Zotero.Tags.setColor(item.libraryID, "cv-test-blue", "", 0);
      await Zotero.Tags.setColor(item.libraryID, "cv-test-red", "", 0);
    }
  });

  it("collapses excess tags at small sizes and expands them on resize without extra caption rows", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const keys = [
      "enableGridView",
      "showTitles",
      "showCreators",
      "showYears",
      "tileSize",
    ] as const;
    const saved = keys.map(getPref);
    const item = new Zotero.Item("book");
    item.setField("title", "Readable title space");
    const tags = [
      "⭐ First",
      "📚 Second",
      "✅ Third",
      "🔥 Fourth",
      "🎉 Fifth",
      "🌈 Sixth",
    ];
    item.setTags(tags.map((tag) => ({ tag })));
    try {
      setPref("enableGridView", true);
      setPref("showTitles", true);
      setPref("showCreators", false);
      setPref("showYears", false);
      setPref("tileSize", 90);
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      await waitFor(
        () =>
          !!grid.querySelector(
            `[data-item-id="${item.id}"] .grid-view-tag-overflow`,
          ),
      );
      const tile = grid.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      const image = tile.querySelector("img");
      const title = tile.querySelector<HTMLElement>(".grid-view-title")!;
      const row = title.parentElement!;
      const overflow = tile.querySelector<HTMLElement>(
        ".grid-view-tag-overflow",
      )!;
      const hidden = Array.from(
        tile.querySelectorAll<HTMLElement>(".grid-view-tag[hidden]"),
      );
      assert.equal(overflow.textContent, `+${hidden.length}`);
      assert.equal(overflow.title, hidden.map((node) => node.title).join("\n"));
      assert.isAtLeast(title.clientWidth, row.clientWidth * 0.5);
      assert.equal(tile.querySelectorAll("figcaption > *").length, 1);
      assert.isAtMost(row.scrollWidth, row.clientWidth);
      const smallVisible = tile.querySelectorAll(
        ".grid-view-tag:not([hidden])",
      ).length;
      setPref("tileSize", 360);
      await waitFor(
        () =>
          tile.querySelectorAll(".grid-view-tag:not([hidden])").length >
          smallVisible,
      );
      assert.notExists(tile.querySelector(".grid-view-tag-overflow"));
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${item.id}"]`),
        tile,
      );
      assert.strictEqual(tile.querySelector("img"), image);
    } finally {
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (item.id) await item.eraseTx();
    }
  });

  it("refreshes item tags and library colours live while keeping covers, selection, and focus", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const keys = ["enableGridView", "showTitles"] as const;
    const saved = keys.map(getPref);
    const item = new Zotero.Item("book");
    item.setField("title", "Live tags");
    try {
      setPref("enableGridView", true);
      setPref("showTitles", true);
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      await waitFor(
        () => !!grid.querySelector(`[data-item-id="${item.id}"]`),
        "Live tile appears",
      );
      const tile = grid.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      tile.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => !!grid.getAttribute("aria-activedescendant"),
        "Grid focus appears",
      );
      const focus = grid.getAttribute("aria-activedescendant");
      const image = tile.querySelector("img");
      item.addTag("✅ Current");
      item.addTag("cv-live-colour");
      await item.saveTx();
      await waitFor(
        () => tile.querySelector(".grid-view-tag")?.textContent === "✅",
        "Added emoji tag appears",
      );
      await Zotero.Tags.setColor(
        item.libraryID,
        "cv-live-colour",
        "#00ff00",
        0,
      );
      await waitFor(
        () =>
          tile.querySelector<HTMLElement>(".grid-view-tag-swatch")?.style
            .color === "rgb(0, 255, 0)",
        "Assigned colour appears",
      );
      await Zotero.Tags.setColor(
        item.libraryID,
        "cv-live-colour",
        "#ff0000",
        0,
      );
      await waitFor(
        () =>
          tile.querySelector<HTMLElement>(".grid-view-tag-swatch")?.style
            .color === "rgb(255, 0, 0)",
        "Changed colour appears",
      );
      setPref("showTitles", false);
      await waitFor(
        () => !tile.querySelector(".grid-view-title-row"),
        "Title hides",
      );
      item.removeTag("✅ Current");
      await item.saveTx();
      setPref("showTitles", true);
      await waitFor(
        () => tile.querySelectorAll(".grid-view-tag").length === 1,
        "Title returns with current tags",
      );
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${item.id}"]`),
        tile,
      );
      assert.strictEqual(tile.querySelector("img"), image);
      assert.equal(tile.getAttribute("aria-selected"), "true");
      assert.equal(grid.getAttribute("aria-activedescendant"), focus);
      assert.strictEqual(win.document.activeElement, grid);
    } finally {
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (item.id) await item.eraseTx();
      await Zotero.Tags.setColor(
        Zotero.Libraries.userLibraryID,
        "cv-live-colour",
        "",
        0,
      );
    }
  });

  it("uses native number shortcuts to toggle tags on the selection, including numpad and 0", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const enabled = getPref("enableGridView");
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const libraryID = Zotero.Libraries.userLibraryID;
    const press = (code: string, extra: KeyboardEventInit = {}) => {
      const event = new win.KeyboardEvent("keydown", {
        key: code.slice(-1),
        code,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      // Observe grid handling without allowing window-level tab shortcuts.
      grid.addEventListener("keydown", (event) => event.stopPropagation(), {
        once: true,
      });
      grid.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      setPref("enableGridView", true);
      for (const [index, item] of items.entries()) {
        item.setField("title", `Number shortcut ${index}`);
        await item.saveTx();
      }
      await Zotero.Tags.setColor(libraryID, "cv-number-one", "#ff6666", 0);
      await Zotero.Tags.setColor(libraryID, "cv-number-two", "#2ea8e5", 1);
      await win.ZoteroPane.selectItems(
        items.map((item) => item.id),
        true,
      );
      await waitFor(() =>
        items.every(
          (item) => !!grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      assert.isTrue(press("Digit1"));
      await waitFor(
        () => items.every((item) => item.hasTag("cv-number-one")),
        "Number 1 adds native tag to selection",
      );
      assert.isTrue(press("Numpad1"));
      await waitFor(
        () => items.every((item) => !item.hasTag("cv-number-one")),
        "Number 1 toggles tag off",
      );
      press("Digit2");
      await waitFor(
        () => items.every((item) => item.hasTag("cv-number-two")),
        "Number 2 uses second colour position",
      );
      press("Digit1");
      await waitFor(() => items.every((item) => item.hasTag("cv-number-one")));
      await waitFor(
        () =>
          grid.querySelectorAll(
            `[data-item-id="${items[0].id}"] .grid-view-tag-swatch`,
          ).length === 2,
      );
      const swatches = grid.querySelectorAll<HTMLElement>(
        `[data-item-id="${items[0].id}"] .grid-view-tag-swatch`,
      );
      const firstRect = swatches[0].getBoundingClientRect();
      const secondRect = swatches[1].getBoundingClientRect();
      assert.closeTo(firstRect.width, 12, 0.1, "Native-size swatch");
      assert.closeTo(
        secondRect.left - firstRect.left,
        7,
        0.1,
        "Native half-overlap",
      );
      assert.include(
        win.getComputedStyle(swatches[1]).backgroundImage,
        "tag-crescent",
      );
      const title = swatches[1]
        .closest(".grid-view-title-row")!
        .querySelector(".grid-view-title")!;
      assert.closeTo(
        title.getBoundingClientRect().left,
        secondRect.right,
        0.1,
        "Indicators directly adjoin title",
      );
      press("Digit0");
      await waitFor(
        () =>
          items.every(
            (item) =>
              !item.hasTag("cv-number-two") && !item.hasTag("cv-number-one"),
          ),
        "Number 0 clears coloured tags",
      );
      assert.sameMembers(
        win.ZoteroPane.getSelectedItems(true),
        items.map((item) => item.id),
      );
      // The native selection write starts asynchronously; the tag command must
      // wait and operate on the newly clicked item, not the previous selection.
      grid
        .querySelector(`[data-item-id="${items[1].id}"]`)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      press("Digit1");
      await waitFor(() => items[1].hasTag("cv-number-one"));
      assert.isFalse(items[0].hasTag("cv-number-one"));
    } finally {
      setPref("enableGridView", enabled);
      for (const item of items) if (item.id) await item.eraseTx();
      await Zotero.Tags.setColor(libraryID, "cv-number-one", "", 0);
      await Zotero.Tags.setColor(libraryID, "cv-number-two", "", 0);
    }
  });

  it("uses each library's colours and keeps coloured emoji as emoji indicators", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const group = new Zotero.Group({
      groupID: Date.now(),
      name: "Tag indicator colours",
      description: "",
      version: 0,
    });
    const userLibraryID = Zotero.Libraries.userLibraryID;
    try {
      group.editable = true;
      group.filesEditable = true;
      await group.saveTx();
      await Zotero.SyncedSettings.loadAll(group.libraryID);
      await Zotero.Tags.setColor(
        userLibraryID,
        "cv-library-colour",
        "#ff0000",
        0,
      );
      await Zotero.Tags.setColor(
        group.libraryID,
        "cv-library-colour",
        "#0000ff",
        0,
      );
      await Zotero.Tags.setColor(group.libraryID, "📚 Reading", "#00ff00", 1);
      for (const [libraryID, colour] of [
        [userLibraryID, "rgb(255, 0, 0)"],
        [group.libraryID, "rgb(0, 0, 255)"],
      ] as const) {
        const item = new Zotero.Item("book");
        item.libraryID = libraryID;
        item.setField("title", "Library-specific tags");
        item.setTags([{ tag: "cv-library-colour" }, { tag: "📚 Reading" }]);
        renderer.setItems([item], { showCreators: false });
        assert.equal(
          host.querySelector<HTMLElement>(".grid-view-tag-swatch")!.style.color,
          colour,
        );
        assert.equal(
          host.querySelector(".grid-view-tag-emoji")!.textContent,
          "📚",
        );
        renderer.setItems([item], { showCreators: false, showTitles: false });
        assert.notExists(host.querySelector(".grid-view-tags"));
        item.setTags([]);
        renderer.setItems([item], { showCreators: false });
        assert.notExists(host.querySelector(".grid-view-tags"));
      }
    } finally {
      renderer.destroy();
      await Zotero.Tags.setColor(userLibraryID, "cv-library-colour", "", 0);
      await group.eraseTx();
    }
  });

  it("updates tags after returning from a reader tab without replacing the cover", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const enabled = getPref("enableGridView");
    const showTitles = getPref("showTitles");
    const item = new Zotero.Item("book");
    let tabID: string | undefined;
    try {
      setPref("enableGridView", true);
      setPref("showTitles", true);
      item.setField("title", "Deferred tags");
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      await waitFor(() => !!grid.querySelector(`[data-item-id="${item.id}"]`));
      const tile = grid.querySelector(`[data-item-id="${item.id}"]`)!;
      const image = tile.querySelector("img");
      tabID = win.Zotero_Tabs.add({
        type: "reader",
        title: "Deferred tags",
        data: { itemID: item.id },
        select: true,
      }).id;
      item.addTag("🌈 Updated");
      await item.saveTx();
      await Zotero.Promise.delay(100);
      assert.notExists(tile.querySelector(".grid-view-tag"));
      win.Zotero_Tabs.select("zotero-pane");
      await waitFor(
        () => tile.querySelector(".grid-view-tag")?.textContent === "🌈",
      );
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${item.id}"]`),
        tile,
      );
      assert.strictEqual(tile.querySelector("img"), image);
    } finally {
      win.Zotero_Tabs.select("zotero-pane");
      if (tabID) win.Zotero_Tabs.close(tabID);
      setPref("enableGridView", enabled);
      setPref("showTitles", showTitles);
      if (item.id) await item.eraseTx();
    }
  });

  it("leaves modified number keys unhandled at the grid renderer boundary", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    try {
      for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
        const event = new win.KeyboardEvent("keydown", {
          key: "1",
          code: "Digit1",
          cancelable: true,
          [modifier]: true,
        });
        host.dispatchEvent(event);
        assert.isFalse(event.defaultPrevented, modifier);
      }
    } finally {
      renderer.destroy();
    }
  });

  it("renders current tag indicators when an unvisited tile is revealed", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const items: Zotero.Item[] = [];
    try {
      await Zotero.DB.executeTransaction(async () => {
        for (let index = 0; index < 121; index++) {
          const item = new Zotero.Item("book");
          item.setField("title", `Deferred item ${index}`);
          await item.save();
          items.push(item);
        }
      });
      const last = items[120];
      renderer.setItems(items, { showCreators: false });
      assert.notExists(host.querySelector(`[data-item-id="${last.id}"]`));
      last.addTag("🔥 Current");
      await last.saveTx();
      renderer.setItems(items, { showCreators: false });
      assert.notExists(host.querySelector(`[data-item-id="${last.id}"]`));
      renderer.setFocusedItem(last.id);
      assert.equal(
        host.querySelector(`[data-item-id="${last.id}"] .grid-view-tag`)
          ?.textContent,
        "🔥",
      );
    } finally {
      renderer.destroy();
      await Zotero.DB.executeTransaction(async () => {
        for (const item of items) await item.erase();
      });
    }
  });

  it("treats numpad physical keys as tag shortcuts even with NumLock off", function () {
    const win = Zotero.getMainWindow()!;
    const host = createRendererHost();
    const commands: string[] = [];
    const navigation: string[] = [];
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => navigation.push(command),
      undefined,
      (command, options) => commands.push(`${command}:${options.tagNumber}`),
    );
    try {
      for (const [code, key] of [
        ["Numpad1", "End"],
        ["Numpad2", "ArrowDown"],
        ["Numpad3", "PageDown"],
        ["Numpad7", "Home"],
        ["Numpad0", "Insert"],
      ]) {
        host.dispatchEvent(
          new win.KeyboardEvent("keydown", { code, key, cancelable: true }),
        );
      }
      assert.deepEqual(commands, [
        "toggle-tag:1",
        "toggle-tag:2",
        "toggle-tag:3",
        "toggle-tag:7",
        "toggle-tag:0",
      ]);
      assert.isEmpty(navigation);
    } finally {
      renderer.destroy();
    }
  });
});
