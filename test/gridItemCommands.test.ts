import { assert } from "chai";
import {
  GridFixture,
  GridWindow,
  holdNextSelectionWrite,
  Modifiers,
  onTeardown,
  openGrid,
  patch,
  setPref,
  until,
} from "./helpers/gridFixture";

type ItemActions = {
  viewItems(items: Zotero.Item[], event?: Event): Promise<void>;
  deleteSelectedItems(force?: boolean): Promise<void>;
  buildItemContextMenu(): Promise<void>;
};

/** Record the items Zotero is asked to open. */
function recordOpenedItems(grid: GridWindow): number[][] {
  const opened: number[][] = [];
  patch(
    grid.pane as unknown as ItemActions,
    "viewItems",
    async (items: Zotero.Item[]) => {
      opened.push(items.map((item) => item.id));
    },
  );
  return opened;
}

/**
 * Delete selected items as Zotero does once the user confirms its prompt.
 * Records the selection each deletion acts on.
 */
function confirmDeletions(grid: GridWindow): number[][] {
  const deleted: number[][] = [];
  const pane = grid.pane;
  patch(
    pane as unknown as ItemActions,
    "deleteSelectedItems",
    async (force = false) => {
      if (!pane.itemsView?.selection.count) return;
      deleted.push(grid.selectedItems());
      await (
        pane.itemsView as unknown as {
          deleteSelection(force: boolean): Promise<void>;
        }
      ).deleteSelection(force);
    },
  );
  return deleted;
}

/** The modifier that moves deleted items to the trash. */
const forceDelete: Modifiers = Zotero.isMac
  ? { primary: true }
  : { shift: true };

function inCollection(grid: GridFixture, items: number[]): number[] {
  return items.filter((id) => grid.collection.hasItem(id));
}

/**
 * Watch the native item menu. Records the native selection each time it
 * opens, and closes it when the test ends.
 */
function watchItemMenu(grid: GridWindow) {
  const popup = grid.win.document.getElementById(
    "zotero-itemmenu",
  ) as XULPopupElement;
  const openings: number[][] = [];
  const onShowing = (event: Event) => {
    if (event.target === popup) openings.push(grid.selectedItems());
  };
  popup.addEventListener("popupshowing", onShowing);
  onTeardown(async () => {
    popup.removeEventListener("popupshowing", onShowing);
    await close();
  });
  async function close() {
    if (popup.state === "closed") return;
    popup.hidePopup();
    await until(() => popup.state === "closed", "the item menu to close", {
      observe: () => popup.state,
    });
  }
  return {
    openings,
    /** Wait for the menu to open and return the selection it opened for. */
    async opened(): Promise<number[]> {
      await until(() => openings.length, "the item menu to open");
      const selection = openings.at(-1)!;
      await close();
      return selection;
    },
  };
}

describe("grid item commands", function () {
  this.timeout(30000);

  describe("opening items", function () {
    it("opens the native selection with Enter, not the focused tile", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.displayedItems();
      const opened = recordOpenedItems(grid);
      grid.click(first);
      grid.click(second, { shift: true });
      grid.press("ArrowRight", { primary: true });
      await grid.settled();
      assert.equal(grid.focusedItem(), third);

      grid.press("Enter");
      await until(() => opened.length, "Zotero to open items");
      assert.sameMembers(opened[0], [first, second]);
    });

    it("opens nothing with Enter without a selection", async function () {
      const grid = await openGrid({ items: 2 });
      const [first] = grid.displayedItems();
      const opened = recordOpenedItems(grid);
      grid.click(first);
      grid.click(first, { primary: true });
      await grid.settled();

      grid.press("Enter");
      await grid.settled();
      assert.isEmpty(opened);
    });

    it("opens nothing with Enter when too many items are selected", async function () {
      const grid = await openGrid({ items: 25 });
      const opened = recordOpenedItems(grid);
      await grid.select(grid.displayedItems());
      grid.focusGrid();

      grid.press("Enter");
      await grid.settled();
      assert.isEmpty(opened);
    });

    it("opens the double-clicked item", async function () {
      const grid = await openGrid({ items: 2 });
      const [first, second] = grid.displayedItems();
      const opened = recordOpenedItems(grid);
      await grid.select([first]);

      grid.doubleClick(second);
      await until(() => opened.length, "Zotero to open an item");
      assert.deepEqual(opened[0], [second]);
    });
  });

  describe("toggling selection", function () {
    it("toggles the focused item with Space without moving focus", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.displayedItems();
      grid.click(first);
      grid.press("ArrowRight", { primary: true });
      await grid.settled();

      grid.press(" ");
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [first, second]);
      assert.equal(grid.focusedItem(), second);

      grid.press(" ");
      await grid.settled();
      assert.deepEqual(grid.selectedItems(), [first]);
      assert.equal(grid.focusedItem(), second);
    });

    it("deselects the last selected item with Space", async function () {
      const grid = await openGrid({ items: 2 });
      const [first] = grid.displayedItems();
      grid.click(first);
      await grid.settled();

      grid.press(" ");
      await grid.settled();
      assert.isEmpty(grid.selectedItems());
      assert.equal(grid.focusedItem(), first);
    });
  });

  describe("deleting items", function () {
    it("removes the selected item from the collection and focuses its predecessor", async function () {
      const grid = await openGrid({ items: 4 });
      const [first, second, third, fourth] = grid.displayedItems();
      confirmDeletions(grid);
      grid.click(third);
      await grid.settled();

      grid.press("Delete");
      await until(
        () => !grid.displayedItems().includes(third),
        "the item to leave the collection",
      );
      await grid.settled();
      assert.deepEqual(inCollection(grid, [first, second, third, fourth]), [
        first,
        second,
        fourth,
      ]);
      assert.isFalse(Zotero.Items.get(third).deleted, "not moved to the trash");
      assert.equal(grid.focusedItem(), second);

      grid.press("ArrowRight", { shift: true });
      await grid.settled();
      assert.sameMembers(grid.selectedItems(), [second, fourth]);
    });

    it("moves the selected items to the trash with the force modifier", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.displayedItems();
      confirmDeletions(grid);
      grid.click(first);
      grid.click(second, { shift: true });
      await grid.settled();

      grid.press("Delete", forceDelete);
      await until(
        () =>
          Zotero.Items.get(first).deleted && Zotero.Items.get(second).deleted,
        "the items to move to the trash",
      );
    });

    it("deletes nothing without a selection", async function () {
      const grid = await openGrid({ items: 2 });
      const displayed = grid.displayedItems();
      const deleted = confirmDeletions(grid);
      grid.click(displayed[0]);
      grid.click(displayed[0], { primary: true });
      await grid.settled();

      grid.press("Delete");
      grid.press("Delete", forceDelete);
      await grid.settled();
      assert.isEmpty(deleted);
      assert.deepEqual(inCollection(grid, displayed), displayed);
    });

    it("removes the selected item with Backspace on macOS", async function () {
      if (!Zotero.isMac) this.skip();
      const grid = await openGrid({ items: 2 });
      const [first, second] = grid.displayedItems();
      confirmDeletions(grid);
      grid.click(second);
      await grid.settled();

      grid.press("Backspace");
      await until(
        () => !grid.collection.hasItem(second),
        "the item to leave the collection",
      );
      assert.isTrue(grid.collection.hasItem(first));
    });
  });

  describe("commands during a pending selection", function () {
    const commands = [
      { key: "Enter", record: recordOpenedItems },
      { key: "Delete", record: confirmDeletions },
    ];

    for (const { key, record } of commands) {
      it(`${key} acts on a pending selection once Zotero applies it`, async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second, third] = grid.displayedItems();
        await grid.select([first]);
        const actedOn = record(grid);
        const write = holdNextSelectionWrite(grid);

        grid.click(second);
        grid.press(key);
        grid.click(third);
        await write.reached();
        assert.isEmpty(actedOn, "the command waits for the selection");

        write.release();
        await until(() => actedOn.length, `${key} to act`);
        assert.deepEqual(actedOn, [[second]]);
        await grid.settled();
        assert.deepEqual(grid.selectedItems(), [third]);
      });

      it(`${key} is cancelled when Zotero rejects a pending selection`, async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second, third] = grid.displayedItems();
        await grid.select([first]);
        const actedOn = record(grid);
        const write = holdNextSelectionWrite(grid);

        grid.click(second);
        grid.press(key);
        grid.click(third);
        await write.reached();
        write.reject(new Error("Simulated native selection rejection"));
        await grid.settled();
        assert.isEmpty(actedOn);
        assert.deepEqual(grid.selectedItems(), [first]);

        grid.press(key);
        await until(() => actedOn.length, `${key} to act`);
        assert.deepEqual(actedOn, [[first]]);
      });

      it(`${key} is cancelled when Zotero does not apply a pending selection`, async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second, third] = grid.displayedItems();
        await grid.select([first]);
        const actedOn = record(grid);
        const write = holdNextSelectionWrite(grid);

        grid.click(second);
        grid.press(key);
        grid.click(third);
        await write.reached();
        write.discard();
        await grid.settled();
        assert.deepEqual(grid.selectedItems(), [third]);
        assert.isEmpty(actedOn);
      });
    }
  });

  describe("item menu", function () {
    for (const [name, key, modifiers] of [
      ["the context menu key", "ContextMenu", {}],
      ["Shift+F10", "F10", { shift: true }],
    ] as const) {
      it(`opens the native item menu for the selection with ${name}`, async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second, third] = grid.displayedItems();
        const menu = watchItemMenu(grid);
        await grid.select([first, third]);
        grid.focusGrid();
        grid.press("ArrowLeft", { primary: true });
        await grid.settled();
        assert.equal(grid.focusedItem(), second);

        grid.press(key, modifiers);
        assert.sameMembers(await menu.opened(), [first, third]);
        assert.equal(grid.focusedItem(), second, "focus does not move");
      });
    }

    it("opens no item menu without a selection", async function () {
      const grid = await openGrid({ items: 2 });
      const [first] = grid.displayedItems();
      const menu = watchItemMenu(grid);
      grid.click(first);
      grid.click(first, { primary: true });
      await grid.settled();

      grid.press("ContextMenu");
      await grid.settled();
      assert.isEmpty(menu.openings);
    });

    it("reveals the last selected tile when no selected tile is visible", async function () {
      setPref("tileSize", 180);
      const grid = await openGrid({ items: 30 });
      const [first, second] = grid.displayedItems();
      const menu = watchItemMenu(grid);
      grid.focusGrid();
      grid.press("End");
      await grid.settled();
      await grid.select([first, second]);
      assert.isFalse(grid.isVisible(second), "no selected tile is visible");

      grid.press("ContextMenu");
      assert.sameMembers(await menu.opened(), [first, second]);
      assert.isTrue(grid.isVisible(second));
    });

    it("waits for a pending selection before opening", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.displayedItems();
      const menu = watchItemMenu(grid);
      await grid.select([first]);
      const write = holdNextSelectionWrite(grid);

      grid.click(second);
      grid.press("ContextMenu");
      await write.reached();
      assert.isEmpty(menu.openings, "the menu waits for the selection");

      write.release();
      assert.deepEqual(await menu.opened(), [second]);
    });

    it("opens for the whole selection when right-clicking a selected tile", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second] = grid.displayedItems();
      const menu = watchItemMenu(grid);
      await grid.select([first, second]);

      grid.contextMenu(first);
      assert.sameMembers(await menu.opened(), [first, second]);
      assert.equal(grid.focusedItem(), first);
      assert.isTrue(grid.ownsFocus);
    });

    it("selects only an unselected right-clicked tile before opening", async function () {
      const grid = await openGrid({ items: 3 });
      const [first, second, third] = grid.displayedItems();
      const menu = watchItemMenu(grid);
      await grid.select([first]);
      const write = holdNextSelectionWrite(grid);

      grid.contextMenu(second);
      await write.reached();
      assert.isEmpty(menu.openings, "the menu waits for the selection");
      write.release();
      assert.deepEqual(await menu.opened(), [second]);
      assert.equal(grid.focusedItem(), second);
      assert.isTrue(grid.ownsFocus);

      grid.click(third, { shift: true });
      await grid.settled();
      assert.sameMembers(
        grid.selectedItems(),
        [second, third],
        "the right-clicked tile is the anchor",
      );
    });

    describe("when Zotero cannot build the menu", function () {
      function failMenu(grid: GridWindow) {
        let attempted = false;
        patch(
          grid.pane as unknown as ItemActions,
          "buildItemContextMenu",
          async () => {
            attempted = true;
            throw new Error("Simulated item menu failure");
          },
        );
        return () =>
          until(() => attempted, "the grid view to build the item menu");
      }

      it("keeps selection and focus after the keyboard menu fails", async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second] = grid.displayedItems();
        const menu = watchItemMenu(grid);
        const attempted = failMenu(grid);
        grid.click(first);
        grid.press("ArrowRight", { primary: true });
        await grid.settled();

        grid.press("ContextMenu");
        await attempted();
        await grid.settled();
        assert.isEmpty(menu.openings);
        assert.deepEqual(grid.selectedItems(), [first]);
        assert.equal(grid.focusedItem(), second);
      });

      it("keeps the right-clicked selection and focus after the pointer menu fails", async function () {
        const grid = await openGrid({ items: 3 });
        const [first, second] = grid.displayedItems();
        const menu = watchItemMenu(grid);
        const attempted = failMenu(grid);
        grid.click(first);
        await grid.settled();

        grid.contextMenu(second);
        await attempted();
        await grid.settled();
        assert.isEmpty(menu.openings);
        assert.deepEqual(grid.selectedItems(), [second]);
        assert.equal(grid.focusedItem(), second);
      });
    });
  });
});
