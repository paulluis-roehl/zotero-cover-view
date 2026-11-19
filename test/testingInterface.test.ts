import { assert } from "chai";
import {
  createItems,
  getPref,
  GridFixture,
  openGrid,
  setPref,
} from "./helpers/gridFixture";

/** Whether `promise` resolves within `ms`, without waiting longer. */
async function resolvesWithin(
  win: Window,
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: number | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = win.setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([promise.then(() => true), timeout]);
  win.clearTimeout(timer);
  return result;
}

/** Save items into the grid's collection without waiting for their tiles. */
function saveItems(grid: GridFixture, count: number, title?: string) {
  return createItems(Array(count).fill({ title }), grid.collection);
}

describe("testing interface", function () {
  this.timeout(30000);

  describe("settled", function () {
    it("shows saved items and removes erased items", async function () {
      const grid = await openGrid();
      const [item] = await saveItems(grid, 1);
      await grid.settled();
      assert.exists(grid.findTile(item), "saved item has a tile");
      await item.eraseTx();
      await grid.settled();
      assert.notExists(grid.findTile(item), "erased item has no tile");
    });

    it("shows an edited title in the tile caption", async function () {
      const grid = await openGrid({ items: 1 });
      const [item] = grid.items;
      item.setField("title", "Edited caption");
      await item.saveTx();
      await grid.settled();
      assert.equal(grid.captionLines(item)[0]?.text, "Edited caption");
    });

    it("mirrors a native selection change and moves the focused tile", async function () {
      const grid = await openGrid({ items: 2 });
      const [, second] = grid.items;
      grid.focusGrid();
      await grid.pane.selectItems([second.id]);
      await grid.settled();
      assert.deepEqual(grid.presentedSelection(), [second.id]);
      assert.equal(grid.focusedItem(), second.id);
    });

    it("waits for the native selection written by a tile click", async function () {
      const grid = await openGrid({ items: 2 });
      const [, second] = grid.items;
      grid.click(second);
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [second.id]);
      assert.deepEqual(grid.presentedSelection(), [second.id]);
    });

    it("reflects items added while the item tree was shown", async function () {
      const grid = await openGrid({ view: "list" });
      const [item] = await saveItems(grid, 1);
      grid.pressToggle();
      await grid.settled();
      assert.isTrue(grid.showsGrid);
      assert.exists(grid.findTile(item));
    });

    it("applies a changed tile caption preference", async function () {
      setPref("showTitles", true);
      const grid = await openGrid({ items: [{ title: "Caption" }] });
      const [item] = grid.items;
      assert.include(
        grid.captionLines(item).map((line) => line.text),
        "Caption",
      );
      setPref("showTitles", false);
      await grid.settled();
      assert.notInclude(
        grid.captionLines(item).map((line) => line.text),
        "Caption",
      );
    });

    it("shows the current cover of visible tiles", async function () {
      const grid = await openGrid();
      const [item] = await saveItems(grid, 1);
      await grid.settled();
      assert.exists(grid.currentCover(item));
    });

    it("resolves promptly when nothing is pending", async function () {
      const grid = await openGrid({ items: 1 });
      assert.isTrue(await resolvesWithin(grid.win, grid.settled(), 100));
    });

    it("resolves while the item tree is shown", async function () {
      const grid = await openGrid({ items: 1 });
      await grid.showList();
      await grid.pane.selectItems([grid.items[0].id]);
      assert.isTrue(await resolvesWithin(grid.win, grid.settled(), 2000));
    });

    it("resolves when the grid view is detached while work is pending", async function () {
      const grid = await openGrid({ items: 1 });
      setPref("showTitles", !getPref("showTitles"));
      const pending = grid.settled();
      grid.detach();
      assert.isTrue(await resolvesWithin(grid.win, pending, 2000));
      assert.isTrue(await resolvesWithin(grid.win, grid.settled(), 2000));
    });
  });

  describe("endResizeGesture", function () {
    // Three 180px columns fit, but 189px tiles only fit two.
    async function resizableGrid() {
      const grid = await openGrid({ items: 40 });
      grid.setStyle({
        flex: "none",
        "box-sizing": "border-box",
        width: "630px",
        height: "300px",
        padding: "19px",
        gap: "20px",
        "grid-template-columns":
          "repeat(auto-fill,minmax(var(--cover-view-tile-size),1fr))",
      });
      setPref("tileSize", 180);
      await grid.settled();
      // Scroll part-way into the second row, which starts with the fourth item.
      grid.scrollToTile(grid.displayedItems()[grid.columns()], 37);
      await grid.settled();
      return grid;
    }

    it("keeps anchoring the same item across resizes within one gesture", async function () {
      const grid = await resizableGrid();
      const anchor = grid.topRow()[0];
      const clipped = grid.isClippedAtTop(anchor);
      setPref("tileSize", 189);
      setPref("tileSize", 180);
      await grid.settled();
      assert.include(grid.topRow(), anchor);
      assert.equal(grid.isClippedAtTop(anchor), clipped);
    });

    it("anchors the first visible item once the gesture ends", async function () {
      const grid = await resizableGrid();
      setPref("tileSize", 189);
      await grid.settled();
      // Two columns now place the third item first in the top visible row.
      const anchor = grid.displayedItems()[2];
      assert.include(grid.topRow(), anchor);
      const clipped = grid.isClippedAtTop(anchor);
      grid.endResizeGesture();
      setPref("tileSize", 180);
      await grid.settled();
      // Anchoring the fourth item instead would scroll the third out of view.
      assert.include(grid.topRow(), anchor);
      assert.equal(grid.isClippedAtTop(anchor), clipped);
    });
  });
});
