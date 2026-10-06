import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref } from "../src/utils/prefs";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(condition(), "Cover presentation did not update");
}

function coverCacheDirectory(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "coverview",
    "covers",
    "open-library",
  );
}

function jpegFixture(win: _ZoteroTypes.MainWindow): Uint8Array {
  const canvas = win.document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 120;
  const context = canvas.getContext("2d")! as CanvasRenderingContext2D;
  context.fillStyle = "#dc315d";
  context.fillRect(0, 0, 120, 120);
  context.fillStyle = "#367dcc";
  context.fillRect(0, 60, 120, 60);
  return Uint8Array.from(
    win.atob(canvas.toDataURL("image/jpeg").split(",")[1]),
    (c) => c.charCodeAt(0),
  );
}

function assertSelectedLetterbox(
  win: _ZoteroTypes.MainWindow,
  tile: HTMLElement,
): void {
  const bounds = tile.getBoundingClientRect();
  const canvas = win.document.createElement("canvas");
  canvas.width = Math.ceil(bounds.width);
  canvas.height = Math.ceil(bounds.height);
  const context = canvas.getContext("2d")! as CanvasRenderingContext2D & {
    drawWindow(
      win: Window,
      x: number,
      y: number,
      width: number,
      height: number,
      background: string,
    ): void;
  };
  context.drawWindow(
    win,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    "white",
  );
  // The square fixture leaves a top letterbox in the portrait frame. Compare
  // its visible colour with the selected tile's uncovered side padding.
  const selection = context.getImageData(1, 20, 1, 1).data;
  const letterbox = context.getImageData(
    Math.floor(bounds.width / 2),
    20,
    1,
    1,
  ).data;
  for (let channel = 0; channel < 3; channel++) {
    assert.closeTo(
      letterbox[channel],
      selection[channel],
      30,
      "Selection remains visible in the letterbox",
    );
  }
}

describe("online cover desaturation", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("defaults off", function () {
    const pref = `${config.prefsPrefix}.desaturateOnlineCovers`;
    const hadValue = Zotero.Prefs.rootBranch.prefHasUserValue(pref);
    const saved = Zotero.Prefs.get(pref, true);
    try {
      Zotero.Prefs.clear(pref, true);
      assert.strictEqual(Zotero.Prefs.get(pref, true), false);
    } finally {
      if (hadValue) Zotero.Prefs.set(pref, saved!, true);
    }
  });

  for (const scenario of ["live display", "source transitions"]) {
    it(
      scenario === "live display"
        ? "applies the preference only to online images in both windows and themes without disturbing library state"
        : "clears treatment when online covers switch to attachments or placeholders",
      async function () {
        this.timeout(30000);
        const first = Zotero.getMainWindow()!;
        const existing = new Set(Zotero.getMainWindows());
        let second: _ZoteroTypes.MainWindow | undefined;
        const keys = [
          "enableGridView",
          "fetchISBNCover",
          "fetchMetadataCover",
          "desaturateOnlineCovers",
          "showItemTypeIcon",
          "showTitles",
          "showCreators",
          "showYears",
        ] as const;
        const saved = keys.map(getPref);
        const savedTileSize = getPref("tileSize");
        const themePref = "browser.theme.toolbar-theme";
        const savedTheme = Zotero.Prefs.get(themePref, true);
        const request = Zotero.HTTP.request;
        const collection = new Zotero.Collection();
        const items: Zotero.Item[] = [];
        const directory = PathUtils.join(
          PathUtils.tempDir,
          "opencode",
          `online-cover-${Zotero.Utilities.randomString()}`,
        );
        const file = PathUtils.join(directory, "cover.jpg");
        const isbn = "9780140328721";
        const edition = "OL987654321M";
        const title = `Online cover ${Zotero.Utilities.randomString()}`;
        const cache = coverCacheDirectory();
        const paths = [
          PathUtils.join(cache, `${isbn}.jpg`),
          PathUtils.join(cache, `${isbn}.missing`),
          PathUtils.join(cache, "olid", `${edition}.jpg`),
          PathUtils.join(cache, "olid", `${edition}.missing`),
          PathUtils.join(
            cache,
            "olid",
            "search",
            `${Zotero.Utilities.Internal.sha1(JSON.stringify([title, "Test, Author"]))}.json`,
          ),
        ];
        let requests = 0;
        try {
          for (const path of paths)
            await IOUtils.remove(path, { ignoreAbsent: true });
          keys.forEach((key) => setPref(key, key !== "desaturateOnlineCovers"));
          setPref("tileSize", 180);
          collection.name = "Online cover presentation";
          await collection.saveTx();
          const bytes = jpegFixture(first);
          await IOUtils.makeDirectory(directory, { createAncestors: true });
          await IOUtils.write(file, bytes);
          Zotero.HTTP.request = (async (_method: string, url: string) => {
            assert.include(
              url,
              "openlibrary.org",
              "No uncontrolled network requests",
            );
            requests++;
            return {
              status: 200,
              response: (url.includes("search.json")
                ? new TextEncoder().encode(
                    JSON.stringify({ docs: [{ cover_edition_key: edition }] }),
                  )
                : bytes
              ).buffer,
            };
          }) as typeof request;
          for (const kind of ["isbn", "metadata", "placeholder"]) {
            const item = new Zotero.Item("book");
            item.setField(
              "title",
              kind === "metadata" ? title : `Cover ${kind}`,
            );
            if (kind === "isbn") item.setField("ISBN", isbn);
            if (kind === "metadata")
              item.setCreators([
                {
                  firstName: "Author",
                  lastName: "Test",
                  creatorType: "author",
                },
              ]);
            item.setCollections([collection.id]);
            item.addTag("🔖");
            await item.saveTx();
            items.push(item);
          }
          const local = await Zotero.Attachments.importFromFile({
            file,
            collections: [collection.id],
          });
          items.push(local);
          Zotero.openMainWindow();
          await waitFor(() => {
            second = Zotero.getMainWindows().find((win) => !existing.has(win));
            return (
              !!second?.ZoteroPane?.itemsView &&
              !!second.ZoteroPane.collectionsView
            );
          });
          Zotero.CoverView.hooks.onMainWindowLoad(second!);
          const windows = [first, second!];
          for (const win of windows)
            await win.ZoteroPane.selectItems(
              items.map((item) => item.id),
              true,
            );
          const grids = windows.map(
            (win) =>
              win.document.getElementById("cover-view-grid")! as HTMLElement,
          );
          const tile = (grid: HTMLElement, item: Zotero.Item) =>
            grid.querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)!;
          const image = (grid: HTMLElement, item: Zotero.Item) =>
            tile(grid, item)?.querySelector<HTMLImageElement>(
              "img:not([hidden])",
            );
          await waitFor(() =>
            grids.every((grid) => items.every((item) => !!image(grid, item))),
          );
          if (scenario === "live display") {
            const images = grids.map((grid) =>
              items.map((item) => image(grid, item)),
            );
            for (const [index, grid] of grids.entries()) {
              tile(grid, items[0]).dispatchEvent(
                new windows[index].MouseEvent("click", { bubbles: true }),
              );
            }
            await waitFor(() =>
              windows.every((win) =>
                win.ZoteroPane.getSelectedItems(true).includes(items[0].id),
              ),
            );
            const focus = grids.map((grid) =>
              grid.getAttribute("aria-activedescendant"),
            );
            first.focus();
            grids[0].focus();
            const initialRequests = requests;
            for (const theme of [1, 0]) {
              Zotero.Prefs.set(themePref, theme, true);
              await waitFor(
                () =>
                  first.matchMedia("(prefers-color-scheme: dark)").matches ===
                  (theme === 0),
              );
              for (const enabled of [true, false]) {
                setPref("desaturateOnlineCovers", enabled);
                await waitFor(() =>
                  grids.every(
                    (grid) =>
                      !!image(grid, items[0]) &&
                      first.getComputedStyle(image(grid, items[0])!).filter ===
                        (enabled ? "saturate(0.65)" : "none"),
                  ),
                );
                for (const [index, grid] of grids.entries()) {
                  assertSelectedLetterbox(windows[index], tile(grid, items[0]));
                }
                for (const [windowIndex, grid] of grids.entries()) {
                  for (const [index, item] of items.entries()) {
                    const cover = image(grid, item)!;
                    assert.strictEqual(cover, images[windowIndex][index]);
                    const style = windows[windowIndex].getComputedStyle(cover);
                    assert.equal(
                      style.filter,
                      enabled && index < 2 ? "saturate(0.65)" : "none",
                    );
                    assert.equal(
                      style.opacity,
                      enabled && index < 2 ? "0.5" : "1",
                    );
                    for (const element of tile(grid, item).querySelectorAll(
                      "figcaption, .grid-view-item-type-badge, .icon-item-type, .grid-view-tag",
                    )) {
                      const decoration =
                        windows[windowIndex].getComputedStyle(element);
                      assert.equal(decoration.filter, "none");
                      assert.equal(decoration.opacity, "1");
                    }
                    for (const selector of [
                      "figcaption",
                      ".grid-view-item-type-badge",
                    ]) {
                      const element = tile(grid, item).querySelector(selector);
                      assert.exists(element);
                    }
                    if (index < 3)
                      assert.exists(
                        tile(grid, item).querySelector(".grid-view-tag"),
                      );
                    assert.equal(
                      windows[windowIndex].getComputedStyle(tile(grid, item))
                        .opacity,
                      "1",
                    );
                    assert.equal(
                      windows[windowIndex].getComputedStyle(
                        cover.parentElement!,
                      ).opacity,
                      "1",
                    );
                  }
                  assert.equal(
                    grid.getAttribute("aria-activedescendant"),
                    focus[windowIndex],
                  );
                  assert.deepEqual(
                    windows[windowIndex].ZoteroPane.getSelectedItems(true),
                    [items[0].id],
                  );
                  if (enabled) {
                    const selectedBacking = windows[
                      windowIndex
                    ].getComputedStyle(
                      image(grid, items[0])!.parentElement!,
                      "::before",
                    ).backgroundColor;
                    const unselectedBacking = windows[
                      windowIndex
                    ].getComputedStyle(
                      image(grid, items[1])!.parentElement!,
                      "::before",
                    ).backgroundColor;
                    assert.equal(
                      selectedBacking,
                      unselectedBacking,
                      "Blending is independent of selection colour",
                    );
                    assert.notInclude(
                      selectedBacking,
                      "/",
                      "Backing has no transparency",
                    );
                    assert.notEqual(selectedBacking, "rgba(0, 0, 0, 0)");
                  }
                }
              }
            }
            assert.equal(
              requests,
              initialRequests,
              "Display changes do not fetch covers",
            );
          } else {
            setPref("desaturateOnlineCovers", true);
            const child = await Zotero.Attachments.importFromFile({
              file,
              parentItemID: items[0].id,
            });
            await waitFor(() =>
              grids.every(
                (grid) =>
                  !!image(grid, items[0]) &&
                  image(grid, items[0])!.src.includes(child.key),
              ),
            );
            for (const grid of grids)
              assert.equal(
                first.getComputedStyle(image(grid, items[0])!).filter,
                "none",
              );
            await child.eraseTx();
            await waitFor(() =>
              grids.every(
                (grid) =>
                  !!image(grid, items[0]) &&
                  first.getComputedStyle(image(grid, items[0])!).filter ===
                    "saturate(0.65)",
              ),
            );
            items[0].setField("ISBN", "");
            await items[0].saveTx();
            await waitFor(() =>
              grids.every(
                (grid) =>
                  !!image(grid, items[0]) &&
                  image(grid, items[0])!.src.startsWith("data:image/svg+xml"),
              ),
            );
            for (const grid of grids)
              assert.equal(
                first.getComputedStyle(image(grid, items[0])!).filter,
                "none",
              );
            for (const grid of grids)
              assert.equal(
                first.getComputedStyle(image(grid, items[0])!).opacity,
                "1",
              );
          }
        } finally {
          Zotero.HTTP.request = request;
          const opened =
            second ?? Zotero.getMainWindows().find((win) => !existing.has(win));
          if (opened) {
            Zotero.CoverView.hooks.onMainWindowUnload(opened);
            opened.close();
          }
          if (savedTheme !== undefined)
            Zotero.Prefs.set(themePref, savedTheme, true);
          else Zotero.Prefs.clear(themePref, true);
          keys.forEach((key, index) => setPref(key, saved[index]));
          setPref("tileSize", savedTileSize);
          for (const item of items) if (item.id) await item.eraseTx();
          if (collection.id) await collection.eraseTx();
          for (const path of paths)
            await IOUtils.remove(path, { ignoreAbsent: true });
          await IOUtils.remove(file, { ignoreAbsent: true });
          await IOUtils.remove(directory, { ignoreAbsent: true });
        }
      },
    );
  }

  it("does not let a stale online response restyle a newer attachment cover", async function () {
    this.timeout(15000);
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const keys = [
      "enableGridView",
      "fetchISBNCover",
      "fetchMetadataCover",
      "desaturateOnlineCovers",
    ] as const;
    const saved = keys.map(getPref);
    const originalRequest = Zotero.HTTP.request;
    const item = new Zotero.Item("book");
    const isbn = "9780142407332";
    const cache = coverCacheDirectory();
    const directory = PathUtils.join(
      PathUtils.tempDir,
      "opencode",
      `stale-online-${Zotero.Utilities.randomString()}`,
    );
    const file = PathUtils.join(directory, "cover.jpg");
    let release: (() => void) | undefined;
    let finished: Promise<unknown> | undefined;
    let child: Zotero.Item | undefined;
    const image = () =>
      grid.querySelector<HTMLImageElement>(
        `[data-item-id="${item.id}"] img:not([hidden])`,
      );
    try {
      for (const extension of ["jpg", "missing"])
        await IOUtils.remove(PathUtils.join(cache, `${isbn}.${extension}`), {
          ignoreAbsent: true,
        });
      keys.forEach((key) => setPref(key, key !== "fetchMetadataCover"));
      const bytes = jpegFixture(win);
      await IOUtils.makeDirectory(directory, { createAncestors: true });
      await IOUtils.write(file, bytes);
      Zotero.HTTP.request = ((_method: string, url: string) => {
        assert.include(
          url,
          `/isbn/${isbn}-L.jpg`,
          "Only the controlled ISBN request is allowed",
        );
        finished = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => ({ status: 200, response: bytes.buffer }));
        return finished;
      }) as typeof originalRequest;
      item.setField("title", "Stale online cover");
      item.setField("ISBN", isbn);
      await item.saveTx();
      await win.ZoteroPane.selectItems([item.id], true);
      await waitFor(() => !!release);
      // Display preferences can change while resolution is pending.
      setPref("desaturateOnlineCovers", false);
      setPref("desaturateOnlineCovers", true);
      child = await Zotero.Attachments.importFromFile({
        file,
        parentItemID: item.id,
      });
      await waitFor(() => !!image() && image()!.src.includes(child!.key));
      const freshImage = image()!;
      assert.equal(win.getComputedStyle(freshImage).filter, "none");
      release!();
      await finished;
      await Zotero.Promise.delay(150);
      assert.strictEqual(image(), freshImage);
      assert.equal(win.getComputedStyle(image()!).filter, "none");
      assert.equal(win.getComputedStyle(image()!).opacity, "1");
      assert.include(image()!.src, child.key);
    } finally {
      release?.();
      await finished;
      Zotero.HTTP.request = originalRequest;
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (item.id) await item.eraseTx();
      // Allow the completed stale lookup's cache write before cleanup.
      await Zotero.Promise.delay(150);
      for (const extension of ["jpg", "missing"])
        await IOUtils.remove(PathUtils.join(cache, `${isbn}.${extension}`), {
          ignoreAbsent: true,
        });
      await IOUtils.remove(file, { ignoreAbsent: true });
      await IOUtils.remove(directory, { ignoreAbsent: true });
    }
  });
});
