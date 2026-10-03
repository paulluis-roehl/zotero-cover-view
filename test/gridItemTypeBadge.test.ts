import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref } from "../src/utils/prefs";

describe("native item-type badges", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("defaults item-type icons on", function () {
    const pref = `${config.prefsPrefix}.showItemTypeIcon`;
    const hadValue = Zotero.Prefs.rootBranch.prefHasUserValue(pref);
    const saved = Zotero.Prefs.get(pref, true);
    try {
      Zotero.Prefs.clear(pref, true);
      assert.isTrue(Zotero.Prefs.get(pref, true));
    } finally {
      if (hadValue) Zotero.Prefs.set(pref, saved!, true);
    }
  });

  it("shows the native book icon and localized type on a placeholder cover", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const enabled = getPref("enableGridView");
    const item = new Zotero.Item("book");
    item.setField("title", "Native badge placeholder");
    try {
      setPref("enableGridView", true);
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      const deadline = Date.now() + 3000;
      while (
        !grid.querySelector(`[data-item-id="${item.id}"]`) &&
        Date.now() < deadline
      )
        await Zotero.Promise.delay(20);
      const tile = grid.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      assert.exists(tile);
      const badge = tile.querySelector<HTMLElement>(
        ".grid-view-item-type-badge",
      );
      assert.exists(badge);
      assert.equal(badge!.title, Zotero.ItemTypes.getLocalizedString("book"));
      const icon = badge!.querySelector<HTMLElement>(".icon-item-type")!;
      assert.equal(icon.dataset.itemType, "book");
      assert.notEqual(win.getComputedStyle(icon).backgroundImage, "none");
      assert.equal(tile.getAttribute("aria-description"), badge!.title);
      assert.strictEqual(
        badge!.parentElement,
        tile.querySelector(".grid-view-cover"),
      );
    } finally {
      setPref("enableGridView", enabled);
      if (item.id) await item.eraseTx();
    }
  });

  it("uses native variants for standalone notes and attachments, on real images and placeholders at every tile size", async function () {
    this.timeout(15000);
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const keys = [
      "enableGridView",
      "showItemTypeIcon",
      "tileSize",
      "fetchISBNCover",
      "fetchMetadataCover",
    ] as const;
    const saved = keys.map(getPref);
    const collection = new Zotero.Collection();
    const themePref = "browser.theme.toolbar-theme";
    const savedTheme = Zotero.Prefs.get(themePref, true);
    const items: Array<{ item: Zotero.Item; icon: string; type: string }> = [];
    const directory = PathUtils.join(
      PathUtils.tempDir,
      "opencode",
      `badge-fixture-${Zotero.Utilities.randomString()}`,
    );
    const path = PathUtils.join(directory, "cover.png");
    const waitFor = async (
      condition: () => boolean,
      message = "Native badge or cover did not appear",
    ) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), message);
    };
    try {
      setPref("enableGridView", true);
      setPref("showItemTypeIcon", true);
      setPref("fetchISBNCover", false);
      setPref("fetchMetadataCover", false);
      collection.name = "Native badge variants";
      await collection.saveTx();
      await IOUtils.makeDirectory(directory, { createAncestors: true });
      const canvas = win.document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 120;
      const context = canvas.getContext("2d")! as CanvasRenderingContext2D;
      context.fillStyle = "#eab24d";
      context.fillRect(0, 0, 240, 120);
      context.fillStyle = "#25354a";
      context.fillRect(0, 80, 240, 40);
      const bytes = Uint8Array.from(
        win.atob(canvas.toDataURL("image/png").split(",")[1]),
        (character) => character.charCodeAt(0),
      );
      await IOUtils.write(path, bytes);
      const image = await Zotero.Attachments.importFromFile({
        file: path,
        collections: [collection.id],
      });
      items.push({ item: image, icon: "attachmentImage", type: "attachment" });
      const linkedImage = await Zotero.Attachments.linkFromFile({
        file: path,
        collections: [collection.id],
      });
      items.push({
        item: linkedImage,
        icon: "attachmentImageLink",
        type: "attachment",
      });
      for (const type of ["film", "journalArticle", "note"] as const) {
        const item = new Zotero.Item(type);
        if (type === "note") item.setNote("<p>Standalone note badge</p>");
        else item.setField("title", `Native badge ${type}`);
        item.setCollections([collection.id]);
        items.push({ item, icon: type, type });
        await item.saveTx();
      }
      for (const [contentType, mode, icon] of [
        [
          "application/pdf",
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          "attachmentPDF",
        ],
        [
          "application/pdf",
          Zotero.Attachments.LINK_MODE_LINKED_FILE,
          "attachmentPDFLink",
        ],
        [
          "application/epub+zip",
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          "attachmentEPUB",
        ],
        [
          "application/epub+zip",
          Zotero.Attachments.LINK_MODE_LINKED_FILE,
          "attachmentEPUBLink",
        ],
        [
          "text/html",
          Zotero.Attachments.LINK_MODE_LINKED_URL,
          "attachmentWebLink",
        ],
        [
          "text/html",
          Zotero.Attachments.LINK_MODE_IMPORTED_URL,
          "attachmentSnapshot",
        ],
        [
          "video/mp4",
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          "attachmentVideo",
        ],
        [
          "application/octet-stream",
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          "attachmentFile",
        ],
        [
          "application/octet-stream",
          Zotero.Attachments.LINK_MODE_LINKED_FILE,
          "attachmentLink",
        ],
      ] as const) {
        const item = new Zotero.Item("attachment");
        item.setField("title", `Native badge ${icon}`);
        item.attachmentLinkMode = mode;
        item.attachmentContentType = contentType;
        item.setCollections([collection.id]);
        items.push({ item, icon, type: "attachment" });
        await item.saveTx();
      }
      await win.ZoteroPane.collectionsView.selectCollection(collection.id);
      for (const theme of [1, 0]) {
        Zotero.Prefs.set(themePref, theme, true);
        await waitFor(
          () =>
            win.matchMedia("(prefers-color-scheme: dark)").matches ===
            (theme === 0),
        );
        for (const size of [90, 180, 360]) {
          setPref("tileSize", size);
          await waitFor(() =>
            items.every(
              ({ item }) =>
                !!grid.querySelector(
                  `[data-item-id="${item.id}"] .grid-view-item-type-badge`,
                ),
            ),
          );
          for (const { item, icon, type } of items) {
            const tile = grid.querySelector<HTMLElement>(
              `[data-item-id="${item.id}"]`,
            )!;
            tile.scrollIntoView({ block: "nearest" });
            await waitFor(
              () => !!tile.querySelector<HTMLImageElement>("img:not([hidden])"),
              `${icon}: ${tile.querySelector("img")?.src}`,
            );
            const cover = tile.querySelector<HTMLImageElement>("img")!;
            assert.isTrue(
              item === image || item === linkedImage
                ? cover.src.startsWith("file:")
                : cover.src.startsWith("data:image/svg+xml"),
            );
            const badge = tile.querySelector<HTMLElement>(
              ".grid-view-item-type-badge",
            )!;
            const nativeIcon =
              badge.querySelector<HTMLElement>(".icon-item-type")!;
            assert.equal(nativeIcon.dataset.itemType, icon);
            assert.equal(item.getItemTypeIconName(), icon);
            assert.equal(
              badge.title,
              Zotero.ItemTypes.getLocalizedString(type),
            );
            assert.notEqual(
              win.getComputedStyle(nativeIcon).backgroundImage,
              "none",
              icon,
            );
            const frame = badge.parentElement!.getBoundingClientRect();
            const bounds = badge.getBoundingClientRect();
            assert.closeTo(
              bounds.top - frame.top,
              5,
              1,
              "Badge anchors to frame top",
            );
            assert.closeTo(
              bounds.left - frame.left,
              5,
              1,
              "Badge anchors to frame left",
            );
            assert.equal(bounds.width, 24);
            assert.equal(bounds.height, 24);
            assert.notEqual(
              win.getComputedStyle(badge).backgroundColor,
              "rgba(0, 0, 0, 0)",
            );
            assert.notEqual(
              win.getComputedStyle(badge).backgroundColor,
              win.getComputedStyle(nativeIcon).fill,
              "Native icon remains distinct from its backing",
            );
          }
        }
      }
    } finally {
      if (savedTheme !== undefined)
        Zotero.Prefs.set(themePref, savedTheme, true);
      else Zotero.Prefs.clear(themePref, true);
      keys.forEach((key, index) => setPref(key, saved[index]));
      for (const { item } of items) if (item.id) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
      await IOUtils.remove(directory, { ignoreAbsent: true });
    }
  });

  it("applies badge visibility live in every window without replacing covers, selection, or focus", async function () {
    this.timeout(15000);
    const first = Zotero.getMainWindow()!;
    const existing = new Set(Zotero.getMainWindows());
    const keys = ["enableGridView", "showItemTypeIcon"] as const;
    const saved = keys.map(getPref);
    const item = new Zotero.Item("book");
    item.setField("title", "Live item-type badge");
    let second: _ZoteroTypes.MainWindow | undefined;
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), "Grid badge visibility did not update");
    };
    try {
      keys.forEach((key) => setPref(key, true));
      await item.saveTx();
      Zotero.openMainWindow();
      await waitFor(() => {
        second = Zotero.getMainWindows().find((win) => !existing.has(win));
        return (
          !!second?.ZoteroPane?.itemsView && !!second.ZoteroPane.collectionsView
        );
      });
      // The scaffold does not dispatch lifecycle hooks for additional windows.
      Zotero.CoverView.hooks.onMainWindowLoad(second!);
      const windows = [first, second!];
      for (const win of windows)
        await win.ZoteroPane.selectItems([item.id], true);
      const grids = windows.map(
        (win) => win.document.getElementById("cover-view-grid")! as HTMLElement,
      );
      const tile = (grid: HTMLElement) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)!;
      await waitFor(() =>
        grids.every(
          (grid) => !!tile(grid)?.querySelector(".grid-view-item-type-badge"),
        ),
      );
      for (const [index, grid] of grids.entries()) {
        tile(grid).dispatchEvent(
          new windows[index].MouseEvent("click", { bubbles: true }),
        );
      }
      await waitFor(() =>
        grids.every(
          (grid) =>
            grid.getAttribute("aria-activedescendant") === tile(grid).id,
        ),
      );
      first.focus();
      grids[0].focus();
      const tiles = grids.map(tile);
      const images = tiles.map((entry) => entry.querySelector("img"));
      const focus = grids.map((grid) =>
        grid.getAttribute("aria-activedescendant"),
      );
      for (const visible of [false, true]) {
        setPref("showItemTypeIcon", visible);
        await waitFor(() =>
          grids.every(
            (grid) =>
              !!tile(grid).querySelector(".grid-view-item-type-badge") ===
              visible,
          ),
        );
        for (const [index, grid] of grids.entries()) {
          assert.strictEqual(tile(grid), tiles[index]);
          assert.strictEqual(tile(grid).querySelector("img"), images[index]);
          assert.equal(
            grid.getAttribute("aria-activedescendant"),
            focus[index],
          );
          assert.deepEqual(windows[index].ZoteroPane.getSelectedItems(true), [
            item.id,
          ]);
          assert.equal(
            tile(grid).getAttribute("aria-description"),
            visible ? Zotero.ItemTypes.getLocalizedString("book") : null,
          );
        }
        assert.strictEqual(first.document.activeElement, grids[0]);
      }
    } finally {
      const opened =
        second ?? Zotero.getMainWindows().find((win) => !existing.has(win));
      if (opened) {
        Zotero.CoverView.hooks.onMainWindowUnload(opened);
        opened.close();
      }
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (item.id) await item.eraseTx();
    }
  });
});
