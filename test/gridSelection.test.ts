import { assert } from "chai";
import {
  blurWindow,
  focus,
  focusWindow,
  GridFixture,
  holdNextSelectionWrite,
  openGrid,
  until,
} from "./helpers/gridFixture";

function background(grid: GridFixture, tile: HTMLElement): string {
  return grid.win.getComputedStyle(tile)!.backgroundColor;
}

describe("selection and focused tile", function () {
  this.timeout(30000);

  describe("following the native selection", function () {
    it("moves the focused tile to a natively selected item, keeping the tiles", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.items;
      grid.click(first);
      await grid.settled();
      const tiles = grid.items.map((item) => grid.tile(item));
      await grid.select([second]);
      assert.equal(grid.focusedItem(), second.id);
      assert.deepEqual(grid.presentedSelection(), [second.id]);
      grid.items.forEach((item, index) =>
        assert.strictEqual(grid.tile(item), tiles[index], "tile kept"),
      );
    });

    it("moves the focused tile to the last displayed item of a multiple selection", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, middle, last] = grid.displayedItems();
      grid.click(middle);
      await grid.settled();
      await grid.select([last, first]);
      assert.equal(grid.focusedItem(), last);
      assert.sameMembers(grid.presentedSelection(), [first, last]);
    });

    it("keeps the focused tile when the selection is cleared", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.items;
      grid.click(first);
      await grid.settled();
      await grid.select([second]);
      await grid.select([]);
      assert.isEmpty(grid.presentedSelection());
      assert.equal(grid.focusedItem(), second.id);
    });

    it("keeps focus and anchor on an item that moves in the displayed order", async function () {
      const grid = await openGrid({ items: 3 });
      const moved = grid.itemByID(grid.displayedItems()[2]);
      grid.click(moved);
      await grid.settled();
      await grid.select([]);

      moved.setField("title", "AAA moved to the front");
      await moved.saveTx();
      await until(
        () => grid.displayedItems()[0] === moved.id,
        "the renamed item to be displayed first",
        { observe: () => grid.displayedItems() },
      );
      await grid.settled();
      assert.equal(grid.focusedItem(), moved.id);

      grid.press("ArrowRight", { shift: true });
      await grid.settled();
      assert.sameMembers(
        grid.selectedItems(),
        grid.displayedItems().slice(0, 2),
      );
    });

    it("presents the native selection when switching from the item tree", async function () {
      const grid = await openGrid({ items: 2, view: "list" });
      const [first, second] = grid.items;
      await grid.select([first]);
      await grid.showGrid();
      assert.deepEqual(grid.presentedSelection(), [first.id]);
      assert.notEqual(
        background(grid, grid.tile(first)),
        background(grid, grid.tile(second)),
        "selected and unselected tiles look different",
      );

      await grid.showList();
      await grid.select([second]);
      await grid.showGrid();
      assert.deepEqual(grid.presentedSelection(), [second.id]);

      await grid.showList();
      await grid.select([]);
      await grid.showGrid();
      assert.isEmpty(grid.presentedSelection());
    });
  });

  describe("focused tile recovery", function () {
    it("falls back to the selected tile, then the first tile, after the focused item is removed in the item tree", async function () {
      const grid = await openGrid({ items: 2 });
      const [first, second] = grid.items;
      grid.click(first);
      await grid.settled();

      await grid.showList();
      await first.eraseTx();
      await grid.select([second]);
      await grid.showGrid();
      assert.equal(grid.focusedItem(), second.id);

      await grid.showList();
      await grid.select([]);
      await second.eraseTx();
      const [remaining] = await grid.addItems(1);
      await grid.showGrid();
      assert.equal(grid.focusedItem(), remaining.id);
    });

    it("moves focus and anchor to the predecessor when the focused item is removed", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, middle, last] = grid.displayedItems();
      grid.click(last);
      await grid.settled();

      await grid.itemByID(last).eraseTx();
      await grid.settled();
      assert.equal(grid.focusedItem(), middle);

      grid.press("ArrowLeft", { shift: true });
      await grid.settled();
      assert.equal(grid.focusedItem(), first);
      assert.sameMembers(grid.selectedItems(), [first, middle]);
    });
  });

  describe("clicking tiles", function () {
    it("selects and focuses a clicked tile", async function () {
      const grid = await openGrid({ items: 2 });
      const [first, second] = grid.items;
      await grid.select([first]);
      grid.focusGrid();
      assert.equal(grid.focusedItem(), first.id);

      grid.click(second);
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [second.id]);
      assert.deepEqual(grid.presentedSelection(), [second.id]);
      assert.equal(grid.focusedItem(), second.id);
      assert.isTrue(grid.ownsFocus);
    });

    it("replaces the selection with a plain click", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.items;
      await grid.select([first, second]);
      grid.click(third);
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [third.id]);
    });

    it("selects the displayed range from the anchor with Shift-click", async function () {
      const grid = await openGrid({ items: 4 });
      const displayed = grid.displayedItems();
      grid.click(displayed[0]);
      grid.click(displayed[2], { shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), displayed.slice(0, 3));
    });

    it("toggles an item with a primary click", async function () {
      const grid = await openGrid({ items: 4 });
      const displayed = grid.displayedItems();
      grid.click(displayed[0]);
      grid.click(displayed[2], { shift: true });
      grid.click(displayed[1], { primary: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [displayed[0], displayed[2]]);
      assert.equal(grid.focusedItem(), displayed[1]);
    });

    it("adds the anchor range to the selection with primary+Shift-click", async function () {
      const grid = await openGrid({ items: 4 });
      const displayed = grid.displayedItems();
      grid.click(displayed[0]);
      grid.click(displayed[2], { primary: true });
      grid.click(displayed[3], { primary: true, shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [
        displayed[0],
        displayed[2],
        displayed[3],
      ]);
    });

    it("moves the anchor to a plainly clicked tile", async function () {
      const grid = await openGrid({ items: 4 });
      const displayed = grid.displayedItems();
      grid.click(displayed[0]);
      grid.click(displayed[2], { shift: true });
      grid.click(displayed[1]);
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [displayed[1]]);

      grid.press("ArrowRight", { shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), displayed.slice(1, 3));
    });

    it("allows an empty selection by primary-clicking the only selected tile", async function () {
      const grid = await openGrid({ items: 2 });
      const [first] = grid.items;
      grid.click(first);
      grid.click(first, { primary: true });
      await grid.settled();
      assert.isEmpty(grid.selectedItems());
      assert.isEmpty(grid.presentedSelection());
      assert.equal(grid.focusedItem(), first.id);
    });
  });

  describe("keyboard selection", function () {
    it("moves only the focused tile with primary+arrow", async function () {
      const grid = await openGrid({ items: 3 });
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      grid.press("ArrowRight", { primary: true });
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [displayed[1]]);
      assert.equal(grid.focusedItem(), displayed[2]);
    });

    it("adds the range to the first tile with primary+Shift+Home", async function () {
      const grid = await openGrid({ items: 4 });
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      grid.click(displayed[3], { primary: true });
      grid.press("ArrowLeft", { primary: true });
      grid.press("Home", { primary: true, shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), displayed);
      assert.equal(grid.focusedItem(), displayed[0]);
    });
  });

  describe("pending native selection", function () {
    it("presents queued click selections once Zotero applies them", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.displayedItems();
      await grid.select([first]);
      const write = holdNextSelectionWrite(grid);

      grid.click(second, { primary: true });
      grid.click(third, { primary: true });
      await write.reached();
      assert.equal(grid.focusedItem(), third);
      assert.deepEqual(
        grid.presentedSelection(),
        [first],
        "a pending selection is not presented as applied",
      );

      write.release();
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [first, second, third]);
      assert.sameMembers(grid.presentedSelection(), [first, second, third]);
    });

    it("applies queued keyboard selections in order", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.displayedItems();
      await grid.select([first, second, third]);
      const write = holdNextSelectionWrite(grid);

      grid.press("Home", { primary: true });
      grid.press(" ");
      grid.press("ArrowRight", { shift: true });
      await write.reached();
      assert.equal(grid.focusedItem(), second);
      assert.sameMembers(grid.presentedSelection(), [first, second, third]);

      write.release();
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [first, second]);
      assert.sameMembers(grid.presentedSelection(), [first, second]);
    });

    it("recovers the native selection after Zotero rejects a queued selection", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.displayedItems();
      await grid.select([first]);
      const write = holdNextSelectionWrite(grid);

      grid.click(second, { primary: true });
      grid.click(third, { primary: true });
      await write.reached();
      write.reject(new Error("Simulated native selection rejection"));
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [first]);
      assert.deepEqual(grid.presentedSelection(), [first]);
      assert.equal(grid.focusedItem(), third);

      // The next primary click starts from the applied native selection.
      grid.click(third, { primary: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [first, third]);
      assert.sameMembers(grid.presentedSelection(), [first, third]);
    });
  });

  describe("inactive selection", function () {
    async function focusedGridWithSelection() {
      const grid = await openGrid({ items: 2 });
      const [item] = grid.items;
      grid.click(item);
      await grid.settled();
      focusWindow(grid.win);
      grid.focusGrid();
      assert.isTrue(grid.ownsFocus, "the grid view owns keyboard focus");
      return {
        grid,
        item,
        activeBackground: background(grid, grid.tile(item)),
      };
    }

    function assertUnchanged(grid: GridFixture, item: Zotero.Item) {
      assert.deepEqual(grid.selectedItems(), [item.id]);
      assert.deepEqual(grid.presentedSelection(), [item.id]);
      assert.equal(grid.focusedItem(), item.id);
    }

    for (const [name, find] of [
      ["the toolbar button", (grid: GridFixture) => grid.toggleButton],
      [
        "the collection tree",
        (grid: GridFixture) =>
          grid.win.document.querySelector<HTMLElement>(
            "#zotero-collections-tree [tabindex]",
          )!,
      ],
      [
        "the item pane",
        (grid: GridFixture) =>
          grid.win.document.querySelector<HTMLElement>(
            "#zotero-item-pane [tabindex]",
          )!,
      ],
    ] as const) {
      it(`dims the selection while ${name} has focus`, async function () {
        const { grid, item, activeBackground } =
          await focusedGridWithSelection();
        focus(find(grid));
        assert.notEqual(background(grid, grid.tile(item)), activeBackground);
        assertUnchanged(grid, item);

        grid.focusGrid();
        assert.equal(background(grid, grid.tile(item)), activeBackground);
        assertUnchanged(grid, item);
      });
    }

    it("dims the selection while the window is inactive", async function () {
      const { grid, item, activeBackground } = await focusedGridWithSelection();
      blurWindow(grid.win);
      assert.notEqual(background(grid, grid.tile(item)), activeBackground);
      assertUnchanged(grid, item);

      focusWindow(grid.win);
      assert.equal(background(grid, grid.tile(item)), activeBackground);
      assertUnchanged(grid, item);
    });
  });

  describe("accessibility", function () {
    it("exposes one focusable listbox with independently focused options", async function () {
      const grid = await openGrid({ items: 2 });
      const [selected, focused] = grid.displayedItems();
      grid.click(selected);
      grid.press("ArrowRight", { primary: true });
      await grid.settled();

      assert.equal(grid.grid.tabIndex, 0);
      assert.equal(grid.grid.getAttribute("role"), "listbox");
      assert.equal(grid.grid.getAttribute("aria-multiselectable"), "true");
      for (const item of [selected, focused]) {
        assert.isFalse(grid.tile(item).hasAttribute("tabindex"));
        assert.equal(grid.tile(item).getAttribute("role"), "option");
      }
      assert.equal(grid.tile(selected).getAttribute("aria-selected"), "true");
      assert.equal(grid.tile(focused).getAttribute("aria-selected"), "false");
      assert.equal(
        grid.grid.getAttribute("aria-activedescendant"),
        grid.tile(focused).id,
      );
    });
  });
});
