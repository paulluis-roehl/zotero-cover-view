import { assert } from "chai";
import {
  createCollection,
  createItems,
  focus,
  focusWindow,
  GridWindow,
  openGrid,
  painted,
  setPref,
  shutDownPlugin,
  until,
} from "./helpers/gridFixture";

/** Wait until the item tree shows `item` as its selected row, in view. */
async function showsSelectedRow(
  view: GridWindow,
  item: Zotero.Item,
): Promise<void> {
  await until(
    () => view.itemTreeShowsSelected(item),
    `the item tree to show "${item.getDisplayTitle()}" as its selected row in view`,
    { observe: () => view.itemTreeRows() },
  );
}

/** Wait until the native item tree owns keyboard focus. */
async function itemTreeOwnsFocus(view: GridWindow): Promise<void> {
  await until(
    () => view.itemTreeOwnsFocus,
    "the native item tree to own focus",
    { observe: () => view.describeFocus() },
  );
}

describe("native item tree restoration", function () {
  this.timeout(30000);

  describe("switching views", function () {
    it("shows the selected row and returns focus to the item tree", async function () {
      const grid = await openGrid({ items: 90 });
      // Native focus restoration waits for an animation frame.
      focusWindow(grid.win);
      const order = grid.displayedItems();
      for (const id of [order.at(-1)!, order[0], order.at(-1)!]) {
        const item = grid.itemByID(id);
        await grid.select([item]);
        grid.focusGrid();
        await grid.showList();
        await showsSelectedRow(grid, item);
        await itemTreeOwnsFocus(grid);
        assert.deepEqual(grid.selectedItems(), [item.id]);
        await grid.showGrid();
      }
    });

    it("moves focus into the grid view, keeping its focused tile", async function () {
      const grid = await openGrid({ items: 2 });
      focusWindow(grid.win);
      const [first, second] = grid.items;
      grid.click(first);
      await grid.settled();
      await grid.showList();
      await itemTreeOwnsFocus(grid);

      await grid.select([second]);
      grid.focusItemTree();
      await grid.showGrid();
      assert.isTrue(grid.ownsFocus, "the grid view owns focus");
      assert.equal(grid.focusedItem(), first.id);
      assert.deepEqual(grid.selectedItems(), [second.id]);
    });

    it("moves focus into the grid view when switched with the toolbar button", async function () {
      const grid = await openGrid({ items: 1, view: "list" });
      focusWindow(grid.win);
      grid.focusItemTree();
      // The toolbar button can take focus before its command is dispatched.
      focus(grid.toggleButton);
      grid.pressToggle();
      await grid.settled();
      await until(() => grid.ownsFocus, "the grid view to own focus", {
        observe: () => grid.describeFocus(),
      });
    });

    it("keeps the grid view's first visible item across a switch to the item tree and back", async function () {
      const grid = await openGrid({ items: 40 });
      grid.setStyle({ flex: "none", width: "630px", height: "300px" });
      setPref("tileSize", 180);
      await grid.settled();
      const anchor = grid.displayedItems()[2 * grid.columns()];
      grid.scrollToTile(anchor, 37);
      await grid.settled();

      await grid.showList();
      await grid.showGrid();
      assert.include(grid.topRow(), anchor);
      assert.isTrue(grid.isClippedAtTop(anchor));
    });
  });

  describe("hot reload", function () {
    it("restores the item tree with its selected row and focus when the grid view is detached", async function () {
      const grid = await openGrid({ items: 90 });
      focusWindow(grid.win);
      const last = grid.itemByID(grid.displayedItems().at(-1)!);
      await grid.select([last]);
      grid.focusGrid();

      grid.detach();
      assert.isFalse(grid.attached, "the grid view is detached");
      assert.isTrue(grid.showsItemTree, "the item tree is shown");
      await showsSelectedRow(grid, last);
      await itemTreeOwnsFocus(grid);
    });

    it("leaves focus in another pane when the grid view is detached", async function () {
      const grid = await openGrid({ items: 1 });
      focusWindow(grid.win);
      const collectionTree = grid.win.document.querySelector(
        "#zotero-collections-tree [role=tree]",
      )!;
      focus(collectionTree);

      grid.detach();
      await painted(grid.win);
      assert.strictEqual(grid.win.document.activeElement, collectionTree);
    });

    it("shows the grid view with the same selection when attached again", async function () {
      const grid = await openGrid({ items: 3 });
      const [, second] = grid.items;
      await grid.select([second]);
      grid.detach();
      await grid.attach();
      assert.isTrue(grid.showsGrid, "the grid view is shown");
      assert.sameMembers(
        grid.mountedItems(),
        grid.items.map(({ id }) => id),
      );
      assert.deepEqual(grid.selectedItems(), [second.id]);
      assert.deepEqual(grid.presentedSelection(), [second.id]);
    });

    it("shows the current collection when attached again", async function () {
      const grid = await openGrid({ items: 1 });
      const other = await createCollection();
      const [item] = await createItems(1, other);
      await grid.showRow(`C${other.id}`, [item]);
      await grid.select([item]);

      grid.detach();
      await grid.attach();
      assert.deepEqual(grid.mountedItems(), [item.id]);
      assert.deepEqual(grid.selectedItems(), [item.id]);
    });

    it("restores the item tree when the plugin shuts down and the grid view when it starts again", async function () {
      const grid = await openGrid({ items: 1 });
      focusWindow(grid.win);
      const [item] = grid.items;
      await grid.select([item]);
      grid.focusGrid();

      const start = shutDownPlugin();
      assert.isFalse(grid.attached, "the grid view is removed");
      await showsSelectedRow(grid, item);
      await itemTreeOwnsFocus(grid);
      assert.deepEqual(grid.selectedItems(), [item.id]);

      await start();
      await grid.settled();
      assert.isTrue(grid.showsGrid, "the grid view is shown");
      assert.deepEqual(grid.mountedItems(), [item.id]);
      assert.deepEqual(grid.selectedItems(), [item.id]);
    });
  });

  describe("new main windows", function () {
    it("restores the item tree and the current collection in each newly opened main window", async function () {
      const grid = await openGrid({ items: 1 });
      const other = await createCollection();
      const [item] = await createItems(2, other);
      for (let cycle = 0; cycle < 2; cycle++) {
        const view = await grid.openWindow();
        focusWindow(view.win);
        await view.showRow(`C${other.id}`, [item]);
        await view.select([item]);
        view.detach();
        await view.attach();
        assert.sameMembers(
          view.mountedItems(),
          other.getChildItems(true),
          `the reattached grid view shows the current collection in window ${cycle + 1}`,
        );

        view.focusGrid();
        await view.showList();
        await showsSelectedRow(view, item);
        await itemTreeOwnsFocus(view);
        await view.showGrid();
        await view.close();
      }
    });
  });
});
