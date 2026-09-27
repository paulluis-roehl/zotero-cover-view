import { assert } from "chai";

describe("grid select all", function () {
  it("selects displayed items beyond the first chunk without moving focus or anchor", async function () {
    this.timeout(120000);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const items: Zotero.Item[] = [];
    const childNote = new Zotero.Item("note");
    const primaryKey = win.navigator.platform.startsWith("Mac")
      ? { metaKey: true }
      : { ctrlKey: true };
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), message);
    };
    const press = (key: string, modifiers = {}) => {
      const event = new win.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      grid.dispatchEvent(event);
      return event;
    };
    const selected = () => pane.getSelectedItems(true);

    try {
      collection.name = `Select all ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      for (let index = 0; index < 121; index++) {
        const item = new Zotero.Item("book");
        item.setField(
          "title",
          `Select all ${collection.id} ${String(index).padStart(3, "0")}`,
        );
        await item.saveTx();
        items.push(item);
      }
      await Zotero.DB.executeTransaction(() => {
        for (const item of items) collection.addItem(item.id);
      });
      childNote.parentItemID = items[0].id;
      childNote.setNote("Child note excluded from grid selection");
      await childNote.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle();
      await waitFor(
        () => grid.querySelectorAll(".grid-view-item").length === 120,
        `Initial chunk: ${grid.querySelectorAll(".grid-view-item").length} tiles, ${pane.getSelectedCollection(true)} selected`,
      );
      assert.exists(grid.querySelector(".grid-view-sentinel"));
      assert.notExists(grid.querySelector(`[data-item-id="${items[120].id}"]`));

      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const ids = items.map((item) => item.id);
      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => selected().length === 1 && selected()[0] === ids[1],
        "First click",
      );
      entries[2].dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, ...primaryKey }),
      );
      await waitFor(() => selected().length === 2, "Primary-click add");
      entries[2].dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, ...primaryKey }),
      );
      await waitFor(() => selected().length === 1, "Primary-click remove");
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[2].id);
      assert.notInclude(selected(), ids[2]);

      const firstTile = entries[0];
      const all = press("a", primaryKey);
      assert.isTrue(all.defaultPrevented);
      await waitFor(
        () => selected().length === ids.length,
        "Partial selection select-all",
      );
      assert.sameMembers(selected(), ids);
      assert.notInclude(selected(), childNote.id);
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[2].id);
      assert.strictEqual(grid.querySelector(".grid-view-item"), firstTile);
      assert.lengthOf(grid.querySelectorAll(".grid-view-item"), 120);
      assert.notExists(grid.querySelector(`[data-item-id="${ids[120]}"]`));
      assert.equal(entries[0].getAttribute("aria-selected"), "true");

      press("ArrowRight", { shiftKey: true });
      await waitFor(
        () => selected().length === 2,
        "Anchor range after select-all",
      );
      assert.deepEqual(
        selected(),
        ids.slice(2, 4),
        "Select all preserves the anchor",
      );

      pane.itemsView!.selection.clearSelection();
      await waitFor(() => selected().length === 0, "Clear selection");
      press("a", primaryKey);
      await waitFor(
        () => selected().length === ids.length,
        "Empty selection select-all",
      );
      assert.sameMembers(selected(), ids, "Empty selection also selects all");

      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      const emptyCollection = new Zotero.Collection();
      emptyCollection.name = `Empty select all ${Date.now()}`;
      emptyCollection.libraryID = Zotero.Libraries.userLibraryID;
      await emptyCollection.saveTx();
      try {
        await pane.collectionsView!.selectByID(`C${emptyCollection.id}`);
        await waitFor(
          () => !grid.querySelector(".grid-view-item"),
          "Empty collection",
        );
        assert.isTrue(press("a", primaryKey).defaultPrevented);
        assert.isEmpty(selected());
        assert.isNull(grid.getAttribute("aria-activedescendant"));
      } finally {
        await pane.collectionsView!.selectLibrary(
          Zotero.Libraries.userLibraryID,
        );
        await emptyCollection.eraseTx();
      }
    } finally {
      if (grid.hidden !== originallyHidden) toggle();
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (childNote.id) await childNote.eraseTx();
      for (const item of items) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });
});
