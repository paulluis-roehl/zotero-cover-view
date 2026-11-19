import { assert } from "chai";
import {
  createItems,
  GridFixture,
  GridWindow,
  ItemSpec,
  Modifiers,
  openGrid,
  setPref,
  until,
} from "./helpers/gridFixture";
import { inventBook } from "./helpers/testEnvironment";

/**
 * The number of tiles in a full row, or `undefined` while all mounted tiles
 * share one row.
 */
function columnCount(grid: GridWindow): number | undefined {
  const rows = new Map<number, number>();
  for (const id of grid.mountedItems()) {
    const top = grid.tile(id).getBoundingClientRect().top;
    rows.set(top, (rows.get(top) ?? 0) + 1);
  }
  return rows.size > 1 ? Math.max(...rows.values()) : undefined;
}

/** The row of a displayed item, counted from the first row. */
function rowOf(grid: GridWindow, item: number, columns: number): number {
  return Math.floor(grid.displayedItems().indexOf(item) / columns);
}

/** The column of a displayed item. */
function columnOf(grid: GridWindow, item: number, columns: number): number {
  return grid.displayedItems().indexOf(item) % columns;
}

/** Books with a creator and a year, so that every caption line is shown. */
function books(count: number): ItemSpec[] {
  return Array.from({ length: count }, () => {
    const book = inventBook();
    return {
      title: book.title,
      setup: (item: Zotero.Item) => {
        item.setCreators([{ ...book.creator, creatorType: "author" }]);
        item.setField("date", book.year);
      },
    };
  });
}

/**
 * Add items until the grid shows at least `rows` rows, the last of them
 * incomplete. Returns the number of columns.
 */
async function fillRows(grid: GridFixture, rows: number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const columns = columnCount(grid);
    if (columns === undefined) {
      await grid.addItems(books(Math.max(grid.displayedItems().length, 2)));
      continue;
    }
    if (columns < 2)
      throw new Error(
        `The grid shows a single column; navigation tests need at least two`,
      );
    const count = grid.displayedItems().length;
    if (Math.ceil(count / columns) >= rows && count % columns) return columns;
    // A scrollbar may appear and change the column count; check again.
    await grid.addItems(books(Math.max(rows * columns - 1 - count, 1)));
  }
  throw new Error(`Could not fill ${rows} rows`);
}

/** Rows that are at least partly inside the grid viewport. */
function visibleRows(grid: GridWindow, columns: number): number[] {
  return [
    ...new Set(grid.visibleItems().map((id) => rowOf(grid, id, columns))),
  ].sort((a, b) => a - b);
}

/**
 * Add items until the grid holds at least `pages` viewports of rows. Returns
 * the number of columns.
 */
async function fillPages(grid: GridFixture, pages: number): Promise<number> {
  let columns = await fillRows(grid, 2);
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = Math.ceil(grid.displayedItems().length / columns);
    const target = pages * visibleRows(grid, columns).length + 1;
    if (rows >= target) return columns;
    columns = await fillRows(grid, target);
  }
  throw new Error(`Could not fill ${pages} pages`);
}

async function press(
  grid: GridWindow,
  key: string,
  modifiers: Modifiers = {},
): Promise<void> {
  grid.press(key, modifiers);
  await grid.settled();
}

function assertFocusedAndSelected(
  grid: GridWindow,
  item: number,
  message?: string,
) {
  assert.equal(grid.focusedItem(), item, message);
  assert.deepEqual(grid.selectedItems(), [item], message);
}

describe("keyboard navigation", function () {
  this.timeout(30000);

  describe("arrow keys", function () {
    beforeEach(function () {
      setPref("tileSize", 90);
    });

    it("moves through the displayed order with Left and Right, across row ends", async function () {
      const grid = await openGrid();
      await fillRows(grid, 2);
      const displayed = grid.displayedItems();
      grid.click(displayed[0]);
      await grid.settled();

      for (const item of displayed.slice(1)) {
        await press(grid, "ArrowRight");
        assertFocusedAndSelected(grid, item);
      }
      await press(grid, "ArrowRight");
      assertFocusedAndSelected(
        grid,
        displayed.at(-1)!,
        "Right stops at the last item",
      );

      for (const item of displayed.slice(0, -1).reverse()) {
        await press(grid, "ArrowLeft");
        assertFocusedAndSelected(grid, item);
      }
      await press(grid, "ArrowLeft");
      assertFocusedAndSelected(
        grid,
        displayed[0],
        "Left stops at the first item",
      );
    });

    it("moves to the same column of the adjacent row with Up and Down", async function () {
      const grid = await openGrid();
      const columns = await fillRows(grid, 3);
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      await grid.settled();

      await press(grid, "ArrowDown");
      assertFocusedAndSelected(grid, displayed[1 + columns]);
      await press(grid, "ArrowUp");
      assertFocusedAndSelected(grid, displayed[1]);
      await press(grid, "ArrowUp");
      assertFocusedAndSelected(grid, displayed[1], "Up stops at the first row");
    });

    it("moves Down into an incomplete last row to its last item", async function () {
      const grid = await openGrid();
      const columns = await fillRows(grid, 3);
      const displayed = grid.displayedItems();
      const rows = Math.ceil(displayed.length / columns);
      const lastColumn = displayed[(rows - 1) * columns - 1];
      grid.click(lastColumn);
      await grid.settled();

      await press(grid, "ArrowDown");
      assertFocusedAndSelected(grid, displayed.at(-1)!);
      await press(grid, "ArrowDown");
      assertFocusedAndSelected(
        grid,
        displayed.at(-1)!,
        "Down stops at the last row",
      );
    });

    it("moves from a focused tile that was scrolled out of view", async function () {
      const grid = await openGrid();
      const columns = await fillRows(grid, 10);
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      await grid.settled();

      grid.grid.scrollTop = grid.grid.scrollHeight;
      grid.grid.dispatchEvent(new grid.win.Event("scroll"));
      await until(
        () => !grid.findTile(displayed[1 + columns]),
        "the tile below the focused tile to be unmounted",
        { observe: () => grid.mountedItems() },
      );
      assert.isFalse(grid.isVisible(displayed[1]), "focus is out of view");

      await press(grid, "ArrowDown");
      assertFocusedAndSelected(grid, displayed[1 + columns]);
      assert.isTrue(grid.isVisible(displayed[1 + columns]));
    });

    it("follows the column count after the tile size changes", async function () {
      const grid = await openGrid();
      const before = await fillRows(grid, 3);
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      await grid.settled();

      setPref("tileSize", 180);
      await grid.settled();
      const after = columnCount(grid)!;
      assert.notEqual(after, before, "the column count changed");

      await press(grid, "ArrowDown");
      assertFocusedAndSelected(grid, displayed[1 + after]);
    });
  });

  describe("Home and End", function () {
    async function largeGrid() {
      setPref("tileSize", 180);
      const grid = await openGrid({ items: 30 });
      const displayed = grid.displayedItems();
      assert.notInclude(
        grid.mountedItems(),
        displayed.at(-1),
        "the last item starts unmounted",
      );
      return { grid, displayed };
    }

    it("reveals and selects the first or last item", async function () {
      const { grid, displayed } = await largeGrid();
      grid.click(displayed[1]);
      await grid.settled();

      await press(grid, "End");
      assertFocusedAndSelected(grid, displayed.at(-1)!);
      assert.isTrue(grid.isVisible(displayed.at(-1)!));

      await press(grid, "Home");
      assertFocusedAndSelected(grid, displayed[0]);
      assert.isTrue(grid.isVisible(displayed[0]));
    });

    it("selects the range from the anchor with Shift", async function () {
      const { grid, displayed } = await largeGrid();
      grid.click(displayed[2]);
      await grid.settled();

      await press(grid, "End", { shift: true });
      assert.equal(grid.focusedItem(), displayed.at(-1));
      assert.sameMembers(grid.selectedItems(), displayed.slice(2));

      await press(grid, "Home", { shift: true });
      assert.equal(grid.focusedItem(), displayed[0]);
      assert.sameMembers(grid.selectedItems(), displayed.slice(0, 3));
    });
  });

  describe("PageUp and PageDown", function () {
    async function pagedGrid(captions: boolean) {
      setPref("tileSize", 90);
      setPref("showTitles", captions);
      setPref("showCreators", captions);
      setPref("showYears", captions);
      const grid = await openGrid();
      const columns = await fillPages(grid, 3);
      return { grid, columns, displayed: grid.displayedItems() };
    }

    for (const captions of [true, false]) {
      const label = captions ? "with captions" : "without captions";

      it(`moves down a page in the focused column ${label}`, async function () {
        const { grid, columns, displayed } = await pagedGrid(captions);
        grid.focusGrid();
        await press(grid, "Home");
        await press(grid, "ArrowRight");
        const column = 1;

        const lastVisible = visibleRows(grid, columns).at(-1)!;
        await press(grid, "PageDown");
        const first = displayed[lastVisible * columns + column];
        assertFocusedAndSelected(
          grid,
          first,
          "PageDown focuses the last visible row",
        );
        assert.isTrue(grid.isVisible(first));

        let previous = first;
        for (let step = 0; step < displayed.length; step++) {
          await press(grid, "PageDown");
          const focused = grid.focusedItem()!;
          if (focused === previous) break;
          assertFocusedAndSelected(grid, focused);
          assert.isAbove(
            displayed.indexOf(focused),
            displayed.indexOf(previous),
          );
          assert.isTrue(
            columnOf(grid, focused, columns) === column ||
              focused === displayed.at(-1),
            "PageDown stays in the focused column",
          );
          assert.isTrue(grid.isVisible(focused));
          previous = focused;
        }
        const lastRow = Math.ceil(displayed.length / columns) - 1;
        assert.equal(rowOf(grid, previous, columns), lastRow);
        assertFocusedAndSelected(
          grid,
          previous,
          "PageDown stops at the last row",
        );
      });

      it(`moves up a page in the focused column ${label}`, async function () {
        const { grid, columns, displayed } = await pagedGrid(captions);
        grid.focusGrid();
        await press(grid, "End");
        const column = columnOf(grid, displayed.at(-1)!, columns);

        const firstVisible = visibleRows(grid, columns)[0];
        await press(grid, "PageUp");
        const first = displayed[firstVisible * columns + column];
        assertFocusedAndSelected(
          grid,
          first,
          "PageUp focuses the first visible row",
        );
        assert.isTrue(grid.isVisible(first));

        let previous = first;
        for (let step = 0; step < displayed.length; step++) {
          await press(grid, "PageUp");
          const focused = grid.focusedItem()!;
          if (focused === previous) break;
          assertFocusedAndSelected(grid, focused);
          assert.isBelow(
            displayed.indexOf(focused),
            displayed.indexOf(previous),
          );
          assert.equal(
            columnOf(grid, focused, columns),
            column,
            "PageUp stays in the focused column",
          );
          assert.isTrue(grid.isVisible(focused));
          previous = focused;
        }
        assert.equal(rowOf(grid, previous, columns), 0);
        assertFocusedAndSelected(
          grid,
          previous,
          "PageUp stops at the first row",
        );
      });
    }

    it("selects the range from the anchor with Shift", async function () {
      const { grid, displayed } = await pagedGrid(true);
      grid.focusGrid();
      await press(grid, "Home");
      await press(grid, "ArrowRight");
      const anchor = displayed.indexOf(grid.focusedItem()!);
      const range = () => {
        const focused = displayed.indexOf(grid.focusedItem()!);
        return displayed.slice(
          Math.min(anchor, focused),
          Math.max(anchor, focused) + 1,
        );
      };

      await press(grid, "PageDown", { shift: true });
      assert.isAbove(displayed.indexOf(grid.focusedItem()!), anchor);
      assert.sameMembers(grid.selectedItems(), range());

      await press(grid, "PageDown", { shift: true });
      assert.sameMembers(grid.selectedItems(), range());

      await press(grid, "PageUp", { shift: true });
      assert.sameMembers(grid.selectedItems(), range());
    });
  });

  describe("select all", function () {
    async function gridWithUnmountedItems() {
      setPref("tileSize", 180);
      const grid = await openGrid({ items: 20 });
      const displayed = grid.displayedItems();
      const [note] = await createItems([
        {
          itemType: "note",
          setup: (item) => {
            item.parentItemID = displayed[0];
            item.setNote("A child note");
          },
        },
      ]);
      await grid.settled();
      assert.isBelow(
        grid.mountedItems().length,
        displayed.length,
        "some items are unmounted",
      );
      return { grid, displayed, note };
    }

    for (const start of ["an empty", "a partial"] as const) {
      it(`selects every displayed item from ${start} selection without moving focus or anchor`, async function () {
        const { grid, displayed, note } = await gridWithUnmountedItems();
        grid.click(displayed[1]);
        if (start === "an empty") grid.click(displayed[1], { primary: true });
        else grid.click(displayed[2], { primary: true });
        await grid.settled();
        const focused = grid.focusedItem()!;

        await press(grid, "a", { primary: true });
        assert.sameMembers(grid.selectedItems(), displayed);
        assert.notInclude(grid.selectedItems(), note.id);
        assert.equal(grid.focusedItem(), focused);

        await press(grid, "ArrowRight", { shift: true });
        const index = displayed.indexOf(focused);
        assert.sameMembers(
          grid.selectedItems(),
          displayed.slice(index, index + 2),
          "Shift extends from the previous anchor",
        );
      });
    }
  });

  describe("other shortcuts", function () {
    const cases: Array<[string, string, Modifiers | "other platform"]> = [
      ["primary+PageUp", "PageUp", { primary: true }],
      ["primary+PageDown", "PageDown", { primary: true }],
      ["primary+Shift+PageDown", "PageDown", { primary: true, shift: true }],
      ["primary+Shift+A", "a", { primary: true, shift: true }],
      ["Alt+primary+A", "a", { primary: true, alt: true }],
      ["the other platform's modifier+A", "a", "other platform"],
      [
        "the other platform's modifier+ArrowRight",
        "ArrowRight",
        "other platform",
      ],
      ["Alt+ArrowRight", "ArrowRight", { alt: true }],
    ];

    for (const [name, key, modifiers] of cases) {
      it(`ignores ${name}`, async function () {
        const grid = await openGrid({ items: 3 });
        const displayed = grid.displayedItems();
        grid.click(displayed[1]);
        await grid.settled();

        await press(
          grid,
          key,
          modifiers !== "other platform"
            ? modifiers
            : Zotero.isMac
              ? { ctrl: true }
              : { meta: true },
        );
        assertFocusedAndSelected(grid, displayed[1]);
      });
    }

    it("ignores Backspace outside macOS", async function () {
      if (Zotero.isMac) this.skip();
      const grid = await openGrid({ items: 3 });
      const displayed = grid.displayedItems();
      grid.click(displayed[1]);
      await grid.settled();

      await press(grid, "Backspace");
      assertFocusedAndSelected(grid, displayed[1]);
      assert.isTrue(grid.collection.hasItem(displayed[1]));
    });
  });

  it("keeps an empty grid focusable and ignores navigation and selection keys", async function () {
    const grid = await openGrid();
    grid.focusGrid();
    for (const [key, modifiers] of [
      ["ArrowLeft", {}],
      ["ArrowRight", {}],
      ["ArrowUp", {}],
      ["ArrowDown", {}],
      ["Home", {}],
      ["End", {}],
      ["PageUp", {}],
      ["PageDown", {}],
      [" ", {}],
      ["a", { primary: true }],
    ] as const) {
      await press(grid, key, modifiers);
      assert.isTrue(grid.ownsFocus, `${key} keeps focus in the grid`);
      assert.isUndefined(grid.focusedItem(), `${key} focuses no tile`);
      assert.isEmpty(grid.selectedItems(), `${key} selects nothing`);
    }
  });
});
