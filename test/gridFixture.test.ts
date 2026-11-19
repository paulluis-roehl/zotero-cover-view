import { assert } from "chai";
import {
  beginFixtureScope,
  endFixtureScope,
  getPref,
  GridWindow,
  openGrid,
  openMainWindow,
  openPreferences,
  patch,
  selectedRow,
  setPref,
  setSyncedSetting,
} from "./helpers/gridFixture";

/** Run `body` as a test in its own Mocha run and return its failures. */
async function runInnerTest(body: () => Promise<void>): Promise<Error[]> {
  const root = new Mocha.Suite("", new Mocha.Context());
  root.timeout(30000);
  root.beforeEach(beginFixtureScope);
  root.afterEach(endFixtureScope);
  root.addTest(new Mocha.Test("inner test", body));
  const runner = new Mocha.Runner(root, {});
  const failures: Error[] = [];
  runner.on("fail", (_test, error) => failures.push(error));
  // The browser Mocha shim resets the uncaught error handler after a run.
  const runnerWindow = globalThis as unknown as { onerror: unknown };
  const onerror = runnerWindow.onerror;
  await new Promise<void>((resolve) => runner.run(() => resolve()));
  runnerWindow.onerror = onerror;
  return failures;
}

describe("grid fixture", function () {
  this.timeout(30000);

  it("shows only the given items", async function () {
    const grid = await openGrid({ items: 3 });
    const ids = grid.items.map((item) => item.id);
    assert.sameMembers(grid.displayedItems(), ids);
    assert.sameMembers(grid.mountedItems(), ids);
    assert.isTrue(grid.showsGrid);
  });

  it("restores everything a failing test touched", async function () {
    setPref("enableGridView", false);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const view = new GridWindow(win);
    const viewItems = pane.viewItems;
    const showTitles = getPref("showTitles");
    const previousRow = selectedRow(pane);
    const previousWindows = Zotero.getMainWindows().length;
    const libraryID = Zotero.Libraries.userLibraryID;
    const renameTemplate = Zotero.SyncedSettings.get(
      libraryID,
      "attachmentRenameTemplate",
    );
    const showedCoverColumn = view.showsColumn("Cover");
    const dragDrop = (
      Zotero as unknown as { DragDrop: { currentDragSource: unknown } }
    ).DragDrop;
    const dragSource = dragDrop.currentDragSource;
    const touched: {
      items: number[];
      collection?: number;
      windows: Window[];
    } = { items: [], windows: [] };

    const failures = await runInnerTest(async () => {
      const grid = await openGrid({ items: 1 });
      touched.collection = grid.collection.id;
      await grid.addItems(1);
      touched.items = grid.items.map((item) => item.id);
      setPref("showTitles", !showTitles);
      patch(pane, "viewItems", async () => {});
      await setSyncedSetting(
        libraryID,
        "attachmentRenameTemplate",
        "{{ year }}",
      );
      grid.showColumn("Cover");
      assert.isTrue(grid.showsColumn("Cover"), "the column is shown");
      assert.isOk(grid.startDrag(grid.items[0]), "the drag starts");
      await grid.showList();
      await grid.showGrid();
      touched.windows.push((await openMainWindow()).win);
      touched.windows.push(await openPreferences());
      throw new Error("Deliberate failure");
    });

    assert.deepEqual(
      failures.map((error) => error.message),
      ["Deliberate failure"],
      "only the deliberate failure is reported",
    );
    assert.lengthOf(touched.items, 2);
    for (const id of touched.items)
      assert.isFalse(Zotero.Items.get(id), `item ${id} is erased`);
    assert.isFalse(
      Zotero.Collections.get(touched.collection!),
      "collection is erased",
    );
    assert.equal(getPref("showTitles"), showTitles);
    assert.strictEqual(pane.viewItems, viewItems);
    assert.equal(
      Zotero.SyncedSettings.get(libraryID, "attachmentRenameTemplate"),
      renameTemplate,
    );
    assert.equal(view.showsColumn("Cover"), showedCoverColumn);
    assert.strictEqual(dragDrop.currentDragSource, dragSource);
    assert.isFalse(getPref("enableGridView"));
    assert.isFalse(view.showsGrid, "the native item tree is shown again");
    assert.equal(selectedRow(pane), previousRow);
    assert.lengthOf(touched.windows, 2);
    for (const opened of touched.windows) assert.isTrue(opened.closed);
    assert.lengthOf(Zotero.getMainWindows(), previousWindows);
  });
});
