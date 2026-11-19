import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import {
  createRenderer,
  displayItems,
  DisplayItemSpec,
  onTeardown,
  RendererFixture,
  until,
} from "./helpers/gridFixture";
import { imageBytes, inventBook, scratchFile } from "./helpers/testEnvironment";

/** A promise that the test resolves later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function shownCover(view: RendererFixture, item: number) {
  return until(
    () => view.findTile(item) && view.currentCover(item),
    `the cover of item ${item} to be shown`,
    { observe: () => view.mountedItems() },
  );
}

/** Specs for items with distinct titles, so that no cover is cached yet. */
function uniqueSpecs(count: number): DisplayItemSpec[] {
  const prefix = inventBook().title;
  return Array.from({ length: count }, (_, index) => ({
    title: `${prefix} ${index + 1}`,
  }));
}

describe("grid virtualization", function () {
  describe("mounting tiles near the viewport", function () {
    it("mounts only tiles near the viewport while jumping through a large collection, even with all items selected", function () {
      const view = createRenderer({ items: 60001, padding: "24px" });
      view.renderer.setSelection(view.displayedItems());
      const height = view.grid.scrollHeight;
      for (const fraction of [0.1, 0.2, 0.3, 0.8, 0.5, 1, 0, 1]) {
        view.scroll(height * fraction);
        view.assertMountsNearViewport();
        assert.equal(view.grid.scrollHeight, height, "the height stays put");
      }
      assert.isTrue(view.atEnd);
      const last = view.displayedItems().at(-1)!;
      assert.isTrue(view.isVisible(last));
      assert.include(view.presentedSelection(), last);
      assert.equal(view.tile(last).getAttribute("aria-posinset"), "60001");
      assert.equal(view.tile(last).getAttribute("aria-setsize"), "60001");
    });

    it("mounts rows exposed by a taller viewport without scrolling", async function () {
      const view = createRenderer({ items: 301 });
      const visible = view.visibleItems();
      await view.restyle({ height: 2000 });
      assert.isTrue(view.atStart);
      assert.isAbove(view.visibleItems().length, visible.length);
      view.assertMountsNearViewport();
    });

    it("keeps the focused tile mounted, and focus-only changes never scroll", function () {
      const view = createRenderer({ items: 3001 });
      const items = view.displayedItems();
      view.renderer.setFocusedItem(items[2]);
      view.scroll(view.grid.scrollHeight);
      assert.equal(view.focusedItem(), items[2]);
      view.assertMountsNearViewport();
      const top = view.grid.scrollTop;
      for (const item of [items[999], items[1999], items[2499]]) {
        view.renderer.setFocusedItem(item);
        assert.equal(view.grid.scrollTop, top, "focus does not scroll");
        assert.equal(view.focusedItem(), item);
        view.assertMountsNearViewport();
      }
      assert.notExists(view.findTile(items[2]), "the old focused tile retires");
    });

    it("remounts tiles with their current captions, tags, selection and focus", function () {
      const view = createRenderer({ items: 3001 });
      const items = view.items;
      const edited = items[1];
      let tags = [{ tag: "⭐ Original", color: null }];
      Object.assign(edited, {
        firstCreator: "Original creator",
        getItemsListTags: () => tags,
        getField: (field: string) => (field === "date" ? "2026" : ""),
      });
      view.setItems(items);
      view.renderer.setSelection([edited.id, items[1499].id]);
      view.scroll(view.grid.scrollHeight);
      assert.notExists(view.findTile(edited));

      edited.firstCreator = "Updated creator";
      tags = [{ tag: "📚 Current", color: null }];
      view.setItems(items);
      view.renderer.setFocusedItem(edited.id, true);
      const tile = view.tile(edited);
      assert.include(tile.textContent, "Updated creator");
      assert.notInclude(tile.textContent, "Original creator");
      assert.include(tile.textContent, "2026");
      assert.exists(tile.querySelector('[title="📚 Current"]'));
      assert.notExists(tile.querySelector('[title="⭐ Original"]'));
      assert.deepEqual(view.presentedSelection(), [edited.id]);
      assert.equal(view.focusedItem(), edited.id);
      view.assertMountsNearViewport();
    });

    it("keeps a dragged tile mounted until the drag ends, even across item updates", async function () {
      const view = createRenderer({ items: 3001, onDragStart: () => {} });
      const win = view.grid.ownerDocument.defaultView!;
      const items = view.items;
      const [dragged] = items;
      const source = view.tile(dragged);
      const start = new win.Event("dragstart", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(start, "dataTransfer", { value: {} });
      source.dispatchEvent(start);

      view.scroll(view.grid.scrollHeight);
      assert.strictEqual(view.findTile(dragged), source);
      view.assertMountsNearViewport([dragged]);
      view.setItems(items.slice().reverse());
      assert.strictEqual(view.findTile(dragged), source, "during an update");

      let mountedDuringDragEnd = false;
      source.addEventListener(
        "dragend",
        () => {
          mountedDuringDragEnd = view.grid.contains(source);
        },
        { once: true },
      );
      source.dispatchEvent(new win.Event("dragend", { bubbles: true }));
      assert.isTrue(mountedDuringDragEnd, "while the drag ends");
      await until(
        () => !view.grid.contains(source),
        "the dragged tile to retire",
      );
      assert.equal(view.displayedItems().at(-1), dragged.id);
      assert.equal(view.tile(dragged).getAttribute("aria-posinset"), "3001");
      view.assertMountsNearViewport();
    });

    it("reveals an offscreen focused tile or menu anchor without mounting the rows in between", function () {
      const view = createRenderer({ items: 3001 });
      const items = view.displayedItems();
      view.renderer.setSelection([items[1], items[1499]]);
      view.renderer.setFocusedItem(items[3000], true);
      assert.equal(view.focusedItem(), items[3000]);
      assert.isTrue(view.isVisible(items[3000]));
      assert.notInclude(view.presentedSelection(), items[3000]);
      view.assertMountsNearViewport();

      const anchor = view.renderer.ensureVisibleMenuAnchor([items[1499]]);
      assert.equal(Number(anchor?.dataset.itemId), items[1499]);
      assert.isTrue(view.isVisible(items[1499]));
      assert.include(view.presentedSelection(), items[1499]);
      assert.equal(view.focusedItem(), items[3000]);
      assert.notExists(view.findTile(items[999]));
      view.assertMountsNearViewport();

      view.renderer.setFocusedItem(undefined);
      assert.isUndefined(view.focusedItem());
    });
  });

  describe("covers", function () {
    it("starts loading covers only for tiles near the viewport", async function () {
      const path = await scratchFile("lazy-cover.png", imageBytes(2, 2));
      const requested = new Set<number>();
      const specs = uniqueSpecs(3001).map((spec, index) => ({
        ...spec,
        imagePath: async () => {
          requested.add(-(index + 1));
          return path;
        },
      }));
      const view = createRenderer({ items: specs });
      const items = view.displayedItems();
      await shownCover(view, items[0]);
      await view.coversSettled();
      assert.isFalse(requested.has(items[3000]), "far covers wait");

      view.scroll(view.grid.scrollHeight);
      const cover = await shownCover(view, items[3000]);
      assert.equal(cover.kind, "attachment");
      assert.isTrue(requested.has(items[3000]));
    });

    it("shows a cover resolving after its tile was remounted, and keeps it across resizes and remounts", async function () {
      const path = await scratchFile("late-cover.png", imageBytes(2, 2));
      const late = deferred<string>();
      let lookups = 0;
      const [spec] = uniqueSpecs(1);
      const view = createRenderer({
        items: [
          {
            ...spec,
            imagePath: () => {
              lookups++;
              // A repeated lookup never completes, so only a kept cover shows.
              return lookups === 1 ? late.promise : new Promise(() => {});
            },
          },
          ...uniqueSpecs(3000),
        ],
      });
      onTeardown(() => late.resolve(path));
      const [item] = view.displayedItems();
      const retired = view.tile(item);
      await until(() => lookups, "the cover lookup to start");

      view.scroll(view.grid.scrollHeight);
      assert.notExists(view.findTile(item));
      view.renderer.setSelection([item]);
      view.renderer.setFocusedItem(item, true);
      assert.notStrictEqual(view.tile(item), retired);
      late.resolve(path);
      const cover = await shownCover(view, item);
      assert.equal(cover.kind, "attachment");
      assert.deepEqual(view.presentedSelection(), [item]);
      assert.equal(view.focusedItem(), item);

      const tile = view.tile(item);
      view.resize({ columns: 2, tileSize: 240 });
      assert.strictEqual(view.tile(item), tile, "resizing keeps the tile");
      assert.deepEqual(view.currentCover(item), cover);

      view.renderer.setFocusedItem(undefined);
      view.scroll(view.grid.scrollHeight);
      assert.notExists(view.findTile(item));
      view.renderer.setFocusedItem(item, true);
      assert.deepEqual(await shownCover(view, item), cover);
    });

    it("ignores covers resolving after the renderer is destroyed, and a replacement renderer works", async function () {
      const path = await scratchFile("destroyed-cover.png", imageBytes(2, 2));
      const late = deferred<string>();
      let started = false;
      const [spec] = uniqueSpecs(1);
      const view = createRenderer({
        items: [
          {
            ...spec,
            imagePath: () => {
              started = true;
              return late.promise;
            },
          },
          ...uniqueSpecs(3000),
        ],
      });
      onTeardown(() => late.resolve(path));
      const [item] = view.displayedItems();
      view.renderer.setFocusedItem(item);
      await until(() => started, "the cover lookup to start");
      const result = CoverProvider.getCoverResult(item);

      view.renderer.destroy();
      late.resolve(path);
      assert.equal((await result)?.source, "attachment");
      view.scroll(0);
      view.renderer.refreshLayout();
      assert.isEmpty(view.mountedItems());
      assert.isUndefined(view.focusedItem());

      const replacement = new GridRenderer(view.host, () => {});
      view.renderer = replacement;
      view.setItems(displayItems(301, 3002));
      assert.notInclude(view.mountedItems(), item);
      view.assertMountsNearViewport();
    });
  });

  describe("layout", function () {
    it("places tiles like a fully populated CSS grid for every caption setting", function () {
      const view = createRenderer({
        columns: 3,
        tileSize: 150,
        height: 200,
        padding: "19px 23px",
        gap: "31px 17px",
      });
      view.host.style.justifyContent = "center";
      const reference = view.host.ownerDocument.createElement("div");
      view.host.after(reference);
      onTeardown(() => reference.remove());
      const items = displayItems(13);
      const last = items.at(-1)!.id;
      const offset = (host: HTMLElement, tile: HTMLElement) => {
        const outer = host.getBoundingClientRect();
        const inner = tile.getBoundingClientRect();
        return [inner.top - outer.top, inner.left - outer.left];
      };
      for (const showTitles of [false, true]) {
        for (const showCreators of [false, true]) {
          for (const showYears of [false, true]) {
            const setting = `titles ${showTitles}, creators ${showCreators}, years ${showYears}`;
            view.setItems(items, { showTitles, showCreators, showYears });
            const tiles = items.map((item) => {
              view.renderer.setFocusedItem(item.id);
              const tile = view.tile(item).cloneNode(true) as HTMLElement;
              tile.style.cssText = "";
              tile.removeAttribute("id");
              return tile;
            });
            reference.style.cssText = view.host.style.cssText;
            reference.style.gridTemplateRows = "none";
            reference.replaceChildren(...tiles);
            assert.closeTo(
              view.host.scrollHeight,
              reference.scrollHeight,
              1,
              setting,
            );
            const actual = offset(view.host, view.tile(last));
            const expected = offset(reference, tiles.at(-1)!);
            assert.closeTo(actual[0], expected[0], 1, `top, ${setting}`);
            assert.closeTo(actual[1], expected[1], 1, `left, ${setting}`);
          }
        }
      }
    });

    it("recomputes the layout after column, caption, sort, filter and emptying changes", function () {
      const view = createRenderer({ items: 301, tileSize: 150 });
      const items = view.items;
      view.renderer.setFocusedItem(items[300].id, true);
      const height = view.grid.scrollHeight;
      view.resize({ columns: 2 });
      assert.isAbove(view.grid.scrollHeight, height);
      assert.equal(view.columns(), 2);

      const captioned = view.grid.scrollHeight;
      view.setItems(items, {
        showCreators: false,
        showTitles: false,
        showYears: false,
      });
      assert.isBelow(view.grid.scrollHeight, captioned);
      const uncaptioned = view.grid.scrollHeight;
      view.resize({ tileSize: 100 });
      assert.isBelow(view.grid.scrollHeight, uncaptioned);

      const filtered = items.slice(0, 3).reverse();
      view.setItems(filtered);
      assert.isTrue(view.atStart);
      assert.deepEqual(
        view.mountedItems(),
        filtered.map((item) => item.id),
      );
      assert.isUndefined(view.focusedItem());

      view.setItems([]);
      assert.isEmpty(view.mountedItems());
      assert.isAtMost(view.grid.scrollHeight, view.grid.clientHeight);
    });
  });
});
