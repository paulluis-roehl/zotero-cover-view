import { assert } from "chai";
import { config } from "../package.json";
import {
  getPref,
  GridWindow,
  openGrid,
  openMainWindow,
  openPreferences,
  setPref,
  until,
} from "./helpers/gridFixture";

function shownView(view: GridWindow): "grid" | "list" {
  assert.notEqual(
    view.showsGrid,
    view.showsItemTree,
    "either the grid view or the item tree is shown",
  );
  return view.showsGrid ? "grid" : "list";
}

describe("grid view preference", function () {
  this.timeout(30000);

  it("shows the grid view or the item tree in every main window, as the preference says", async function () {
    const grid = await openGrid({ items: 1 });
    const second = await openMainWindow();

    setPref("enableGridView", false);
    await grid.settled();
    await second.settled();
    assert.equal(shownView(grid), "list");
    assert.equal(shownView(second), "list");

    setPref("enableGridView", true);
    await grid.settled();
    await second.settled();
    assert.equal(shownView(grid), "grid");
    assert.equal(shownView(second), "grid");
  });

  it("switches views with the toolbar button and remembers the choice", async function () {
    const grid = await openGrid({ items: 1 });
    assert.equal(shownView(grid), "grid");
    assert.isTrue(grid.togglePressed);

    grid.pressToggle();
    await grid.settled();
    assert.equal(shownView(grid), "list");
    assert.isFalse(getPref("enableGridView"));
    assert.isFalse(grid.togglePressed);

    grid.pressToggle();
    await grid.settled();
    assert.equal(shownView(grid), "grid");
    assert.isTrue(getPref("enableGridView"));
    assert.isTrue(grid.togglePressed);
  });

  it("places the toolbar button after the new note button", async function () {
    const grid = await openGrid();
    const noteButton = grid.win.document.getElementById("zotero-tb-note-add");
    assert.strictEqual(noteButton?.nextElementSibling, grid.toggleButton);
  });

  it("switches views from the settings pane", async function () {
    const grid = await openGrid({ items: 1 });
    const prefs = await openPreferences();
    const checkbox = prefs.document.getElementById(
      `zotero-prefpane-${config.addonRef}-enable-grid-view`,
    ) as XULCheckboxElement;
    await until(() => checkbox.checked, "the checkbox to be checked");

    checkbox.click();
    await until(
      () => getPref("enableGridView") === false,
      "the preference to be turned off",
    );
    await grid.settled();
    assert.equal(shownView(grid), "list");
  });
});
