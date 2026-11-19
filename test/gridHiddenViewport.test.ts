import { assert } from "chai";
import {
  createRenderer,
  displayItems,
  focus,
  GridFixture,
  GridViewport,
  openGrid,
  patch,
  RendererLayout,
  setPref,
  until,
} from "./helpers/gridFixture";

/** Scroll a few rows down, partly past a tile, and return that tile's item. */
function scrollToThirdRow(view: GridViewport): number {
  const anchor = view.displayedItems()[2 * view.columns()];
  view.scrollToTile(anchor, 37);
  return anchor;
}

function assertKeeps(view: GridViewport, anchor: number, when: string): void {
  assert.include(
    view.topRow(),
    anchor,
    `item ${anchor} stays in the top visible row ${when}`,
  );
  assert.isTrue(view.isClippedAtTop(anchor), `item ${anchor} stays clipped`);
  view.assertMountsNearViewport();
}

describe("hidden grid viewport", function () {
  describe("while the renderer is hidden", function () {
    const changes: [string, (cycle: number) => RendererLayout | undefined][] = [
      ["no layout", () => undefined],
      ["width", (cycle) => ({ columns: cycle % 2 ? 3 : 2 })],
      ["tile size", (cycle) => ({ tileSize: cycle % 2 ? 180 : 240 })],
    ];
    for (const [change, layout] of changes) {
      it(`keeps the first visible item through repeated hidden ${change} changes`, function () {
        const view = createRenderer({ items: 90 });
        const anchor = scrollToThirdRow(view);
        const tile = view.tile(anchor);
        for (let cycle = 0; cycle < 3; cycle++) {
          view.hide();
          const next = layout(cycle);
          if (next) view.resize(next);
          view.scroll(view.grid.scrollTop);
          view.show();
          assertKeeps(view, anchor, `after cycle ${cycle + 1}`);
          assert.strictEqual(view.tile(anchor), tile, "the tile is kept");
        }
      });
    }

    for (const [when, pause] of [
      ["", false],
      [", even after the gesture pause elapses", true],
    ] as const) {
      it(`keeps the first visible item when a resize gesture continues while hidden${when}`, function () {
        const view = createRenderer({ items: 90 });
        const anchor = scrollToThirdRow(view);
        view.resize({ columns: 4 });
        view.hide();
        view.resize({ columns: 2, tileSize: 240 });
        if (pause) {
          // Hidden tabs often stay in the background for longer than a pause.
          const now = Date.now();
          patch(Date, "now", () => now + 60_000);
        }
        view.show();
        assertKeeps(view, anchor, "after showing");
      });
    }

    it("restores the first visible item after the hidden scroll position was lost", function () {
      const view = createRenderer({ items: 90 });
      const anchor = scrollToThirdRow(view);
      view.hide();
      view.scroll(0);
      view.renderer.refreshLayout();
      view.host.style.display = "grid";
      // Gecko can defer scroll changes until the frame becomes measurable.
      view.host.scrollTop = 0;
      view.renderer.refreshLayout();
      assertKeeps(view, anchor, "after showing");
    });

    for (const change of ["missing item", "new context", "empty grid"]) {
      it(`does not restore item state after a hidden ${change}`, function () {
        const view = createRenderer({ items: 90 });
        const items = view.items;
        const anchor = scrollToThirdRow(view);
        view.renderer.setSelection([anchor]);
        view.renderer.setFocusedItem(anchor);
        view.resize({ columns: 4 });
        view.hide();
        view.setItems(
          change === "missing item"
            ? items.filter((item) => item.id !== anchor)
            : change === "new context"
              ? displayItems(12, 100)
              : [],
        );
        view.renderer.setSelection([]);
        view.renderer.setFocusedItem(undefined);
        view.resize({ columns: 2 });
        view.show();
        assert.notInclude(view.mountedItems(), anchor);
        assert.isEmpty(view.presentedSelection());
        assert.isUndefined(view.focusedItem());
        view.assertMountsNearViewport();
        if (change === "empty grid") assert.isTrue(view.atStart);
      });
    }

    for (const boundary of ["start", "end"] as const) {
      it(`keeps the ${boundary} of the grid in view through a hidden column change`, function () {
        const view = createRenderer({ items: 301 });
        view.scroll(boundary === "start" ? 0 : view.grid.scrollHeight);
        view.hide();
        view.resize({ columns: 5 });
        view.show();
        if (boundary === "start") assert.isTrue(view.atStart);
        // Unlike a visible change, the hidden restore may stop short of the
        // end by the tile margin, but it still shows almost all of the last tile.
        else
          assert.isAbove(
            view.visibleShare(view.displayedItems().at(-1)!),
            0.95,
          );
        view.assertMountsNearViewport();
      });
    }

    it("applies item, layout and focus changes made while hidden once shown", function () {
      const view = createRenderer({ items: 301 });
      view.renderer.setFocusedItem(view.items[300].id, true);
      view.hide();
      view.resize({ columns: 2 });
      view.setItems(displayItems(133));
      const last = view.items[132].id;
      view.renderer.setFocusedItem(last);
      assert.isUndefined(view.focusedItem(), "no tile is focused while hidden");
      view.show();
      view.renderer.setFocusedItem(last, true);
      assert.equal(view.focusedItem(), last);
      assert.isTrue(view.isVisible(last));
      assert.equal(view.columns(), 2);
      view.assertMountsNearViewport();
    });
  });

  describe("while a reader tab is in front", function () {
    /**
     * Select an item, scroll a few rows down and open a reader tab; then
     * change the width and tile size behind it.
     */
    async function changeBehindReaderTab() {
      const grid = await openGrid({ items: 40 });
      grid.setStyle({ flex: "none", width: "630px", height: "300px" });
      setPref("tileSize", 180);
      await grid.settled();
      const [, selected, next] = grid.displayedItems();
      grid.click(selected);
      await grid.settled();
      const anchor = scrollToThirdRow(grid);
      const cover = await until(
        () => grid.currentCover(anchor),
        `the cover of item ${anchor} to be shown`,
      );
      const tile = grid.tile(anchor);
      const tab = await grid.openReaderTab(selected);
      grid.setStyle({ width: "520px" });
      setPref("tileSize", 240);
      return { grid, tab, anchor, tile, cover, selected, next };
    }

    async function returnToLibrary(grid: GridFixture, anchor: number) {
      await grid.showLibraryTab();
      await until(
        () => grid.findTile(anchor) && grid.topRow().includes(anchor),
        `item ${anchor} to be in the top visible row`,
        { observe: () => grid.topRow() },
      );
    }

    it("keeps the first visible item, its tile and cover across repeated tab switches", async function () {
      const { grid, tab, anchor, tile, cover } = await changeBehindReaderTab();
      await returnToLibrary(grid, anchor);
      assertKeeps(grid, anchor, "after returning");
      for (let cycle = 0; cycle < 3; cycle++) {
        await grid.selectTab(tab);
        await returnToLibrary(grid, anchor);
        assertKeeps(grid, anchor, `after switching tabs ${cycle + 1} times`);
      }
      assert.strictEqual(grid.tile(anchor), tile, "the tile is kept");
      assert.deepEqual(grid.currentCover(anchor), cover, "the cover is kept");
    });

    it("shows item changes made behind it once the library tab is back", async function () {
      const { grid, anchor } = await changeBehindReaderTab();
      const item = grid.itemByID(anchor);
      // Changes that keep the item's place in the displayed order.
      item.setField("date", "1999");
      item.addTag("🌈 Updated");
      await item.saveTx();
      await returnToLibrary(grid, anchor);
      assert.isTrue(
        grid.captionLines(item).some(({ text }) => text.includes("1999")),
        "the caption shows the new year",
      );
      assert.deepEqual(
        grid.tagIndicators(item).shown.map(({ name }) => name),
        ["🌈 Updated"],
      );
    });

    it("keeps the selection, focused tile and selection anchor", async function () {
      const { grid, anchor, selected, next } = await changeBehindReaderTab();
      await returnToLibrary(grid, anchor);
      assertKeeps(grid, anchor, "after returning");
      assert.deepEqual(grid.selectedItems(), [selected]);
      assert.equal(grid.focusedItem(), selected);

      grid.press("ArrowRight", { shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [selected, next]);
    });

    it("leaves keyboard focus where it is when restoring the layout", async function () {
      const { grid, anchor } = await changeBehindReaderTab();
      await returnToLibrary(grid, anchor);
      const tree = grid.win.document.querySelector<HTMLElement>(
        "#zotero-collections-tree [role=tree]",
      )!;
      focus(tree);
      grid.setStyle({ width: "530px" });
      await grid.settled();
      assert.strictEqual(grid.win.document.activeElement, tree);
    });
  });
});
