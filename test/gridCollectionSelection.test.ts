import { assert } from "chai";

describe("grid collection selection", function () {
  it("keeps the current collection when clicking a grid tile", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const item = new Zotero.Item("book");
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition());
    };
    try {
      collection.name = `Grid selection ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      item.setField("title", `Collection tile ${Date.now()}`);
      await item.saveTx();
      await Zotero.DB.executeTransaction(() => collection.addItem(item.id));
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      await waitFor(() => pane.getSelectedCollection(true) === collection.id);
      if (grid.hidden) button.dispatchEvent(new win.Event("command"));
      await waitFor(() => !!grid.querySelector(`[data-item-id="${item.id}"]`));
      grid
        .querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => pane.getSelectedItems(true)[0] === item.id);
      assert.equal(pane.getSelectedCollection(true), collection.id);
    } finally {
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (item.id) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });
});
