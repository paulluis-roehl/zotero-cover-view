import { assert } from "chai";
import { attachTileSizePreference } from "../src/modules/tileSizePreference";
import {
  getPref,
  GridFixture,
  onTeardown,
  openGrid,
  openPreferences,
  setPref,
  until,
} from "./helpers/gridFixture";

const SLIDER_ID = "zotero-prefpane-coverview-tile-size";
const PERCENT_ID = `${SLIDER_ID}-percent`;

/** A grid of fixed size, so that the largest tiles fit its width. */
async function fixedGrid(items = 1): Promise<GridFixture> {
  const grid = await openGrid({ items });
  grid.setStyle({ flex: "none", width: "630px", height: "300px" });
  setPref("tileSize", 180);
  await grid.settled();
  return grid;
}

function tileWidth(grid: GridFixture): number {
  return grid.tile(grid.items[0]).getBoundingClientRect().width;
}

function input(element: HTMLInputElement, value: string, type = "input") {
  element.value = value;
  element.dispatchEvent(
    new element.ownerDocument.defaultView!.Event(type, { bubbles: true }),
  );
}

describe("tile size preference", function () {
  describe("settings controls", function () {
    it("keeps a percentage entry and slider synchronized within 50–200%", function () {
      const doc = Zotero.getMainWindow()!.document;
      const slider = doc.createElement("input");
      const percentage = doc.createElement("input");
      slider.type = "range";
      slider.min = "90";
      slider.max = "360";
      slider.step = "1";
      percentage.type = "number";
      setPref("tileSize", 180);
      onTeardown(attachTileSizePreference(slider, percentage));

      assert.equal(percentage.value, "100");
      input(slider, "270");
      assert.equal(percentage.value, "150");

      input(percentage, "125");
      assert.equal(slider.value, "225");
      assert.equal(getPref("tileSize"), 225);

      input(percentage, "201");
      assert.equal(getPref("tileSize"), 225, "out-of-range input is not saved");
      input(percentage, "201", "change");
      assert.equal(percentage.value, "200");
      assert.equal(slider.value, "360");

      input(percentage, "", "change");
      assert.equal(percentage.value, "200", "empty input restores the size");

      setPref("tileSize", 90);
      input(slider, "90", "syncfrompreference");
      assert.equal(percentage.value, "50");
    });

    it("connects the percentage entry to the settings pane slider", async function () {
      setPref("tileSize", 180);
      const prefs = await openPreferences();
      const slider = prefs.document.getElementById(
        SLIDER_ID,
      ) as HTMLInputElement;
      const percent = prefs.document.getElementById(
        PERCENT_ID,
      ) as HTMLInputElement;
      await until(
        () => percent.value === "100",
        "the percentage to show the tile size",
        { observe: () => percent.value },
      );

      input(slider, "270");
      await until(
        () => percent.value === "150" && getPref("tileSize") === 270,
        "the percentage to follow the slider",
        { observe: () => [percent.value, getPref("tileSize")] },
      );

      input(percent, "125");
      await until(
        () => slider.value === "225" && getPref("tileSize") === 225,
        "the slider to follow the percentage",
        { observe: () => [slider.value, getPref("tileSize")] },
      );
    });
  });

  describe("grid view", function () {
    it("resizes tiles without replacing them when the preference changes", async function () {
      const grid = await fixedGrid();
      const tile = grid.tile(grid.items[0]);
      const width = tileWidth(grid);
      setPref("tileSize", 240);
      await grid.settled();
      assert.isAbove(tileWidth(grid), width);
      setPref("tileSize", 120);
      await grid.settled();
      assert.isBelow(tileWidth(grid), width);
      assert.strictEqual(grid.tile(grid.items[0]), tile);
    });

    it("applies a change made while the native item tree is shown", async function () {
      const grid = await fixedGrid();
      const tile = grid.tile(grid.items[0]);
      const width = tileWidth(grid);
      await grid.showList();
      setPref("tileSize", 240);
      await grid.showGrid();
      assert.isAbove(tileWidth(grid), width);
      assert.strictEqual(grid.tile(grid.items[0]), tile);
    });

    it("keeps the first visible item and the selection when the size is changed in the settings", async function () {
      const grid = await fixedGrid(40);
      const [, selected, next] = grid.displayedItems();
      grid.click(selected);
      await grid.settled();
      grid.scrollToTile(grid.displayedItems()[2 * grid.columns()], 37);
      const prefs = await openPreferences();
      const percent = prefs.document.getElementById(
        PERCENT_ID,
      ) as HTMLInputElement;
      await until(
        () => percent.value === "100",
        "the percentage to show the tile size",
      );

      grid.endResizeGesture();
      const anchor = grid.topRow()[0];
      const clipped = grid.isClippedAtTop(anchor);
      input(percent, "120");
      await grid.settled();
      assert.isAbove(getPref("tileSize"), 180);
      assert.include(grid.topRow(), anchor);
      assert.equal(grid.isClippedAtTop(anchor), clipped);
      assert.deepEqual(grid.selectedItems(), [selected]);
      assert.equal(grid.focusedItem(), selected);

      grid.press("ArrowRight", { shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [selected, next]);
    });
  });
});
