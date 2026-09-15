import { assert } from "chai";

describe("grid view", function () {
  it("toggles between the cover grid and native item list", function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;

    assert.isTrue(button.hasAttribute("checked"));
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isFalse(button.hasAttribute("checked"));
    assert.isTrue(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "none");
    assert.notEqual(itemTree.style.display, "none");
    assert.notEqual(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isTrue(button.hasAttribute("checked"));
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");
  });
});
