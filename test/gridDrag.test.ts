import { assert } from "chai";
import {
  createCollection,
  openGrid,
  track,
  until,
} from "./helpers/gridFixture";
import { pdfBytes, scratchFile } from "./helpers/testEnvironment";

describe("grid item drag", function () {
  this.timeout(60000);

  it("carries a standalone attachment's file, but not a parent's child files", async function () {
    const grid = await openGrid({ items: 1 });
    const [parent] = grid.items;
    const path = await scratchFile("dragged.pdf", pdfBytes());
    const standalone = await Zotero.Attachments.importFromFile({
      file: path,
      collections: [grid.collection.id],
    });
    const child = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parent.id,
    });
    track(standalone);
    assert.equal(child.parentItemID, parent.id);
    await grid.showsItems([standalone]);

    const fromAttachment = grid.startDrag(standalone)!;
    grid.endDrag();
    assert.equal(fromAttachment.getData("zotero/item"), String(standalone.id));
    assert.include(
      Array.from(fromAttachment.types),
      "application/x-moz-file",
      "the attachment's file is dragged",
    );

    const fromParent = grid.startDrag(parent)!;
    grid.endDrag();
    assert.equal(fromParent.getData("zotero/item"), String(parent.id));
    assert.notInclude(
      Array.from(fromParent.types),
      "application/x-moz-file",
      "the child's file is not dragged",
    );
  });

  it("drags mounted and unmounted selected items in displayed order without changing the selection", async function () {
    const grid = await openGrid({ items: 150 });
    const order = grid.displayedItems();
    const [first, second] = order;
    const middle = order[75];
    const last = order.at(-1)!;
    await grid.select([last, middle, first]);
    assert.isNull(grid.findTile(middle), "the middle item is not mounted");

    const transfer = grid.startDrag(first)!;
    grid.endDrag();
    assert.equal(
      transfer.getData("zotero/item"),
      [first, middle, last].join(","),
    );
    assert.sameMembers(grid.selectedItems(), [first, middle, last]);

    const alone = grid.startDrag(second)!;
    grid.endDrag();
    assert.equal(alone.getData("zotero/item"), String(second));
    await grid.settled();
    assert.sameMembers(grid.selectedItems(), [first, middle, last]);
  });

  it("offers the item's Quick Copy text", async function () {
    // Zotero loads the citation styles Quick Copy needs on first use.
    await Zotero.Styles.init();
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    const transfer = grid.startDrag(item)!;
    grid.endDrag();
    assert.include(
      transfer.getData("text/plain").toLowerCase(),
      item.getField("title").toLowerCase(),
    );
  });

  it("keeps the dragged tile while the grid scrolls during the drag", async function () {
    const grid = await openGrid({ items: 150 });
    const [, dragged] = grid.displayedItems();
    assert.notEqual(
      grid.focusedItem(),
      dragged,
      "the dragged tile is not kept as the focused one",
    );
    grid.startDrag(dragged);
    grid.scroll(grid.grid.scrollHeight);
    await grid.settled();
    assert.isFalse(
      grid.isVisible(dragged),
      "the dragged tile is scrolled away",
    );
    assert.isNotNull(grid.findTile(dragged), "the dragged tile stays mounted");

    grid.endDrag();
    await grid.settled();
    assert.isNull(
      grid.findTile(dragged),
      "the tile is released after the drag",
    );
  });

  it("adds items dropped on another collection while keeping them in their own", async function () {
    const grid = await openGrid({ items: 2 });
    const [first, second] = grid.displayedItems();
    const destination = await createCollection();
    await grid.select([first, second]);

    const ownRow = grid.collectionRow(grid.collection);
    assert.isFalse(
      grid.dragOver(ownRow, grid.startDrag(first)!).accepted,
      "their own collection refuses them",
    );
    grid.endDrag();

    const transfer = grid.startDrag(first)!;
    const row = grid.collectionRow(destination);
    const { accepted, dropEffect } = grid.dragOver(row, transfer);
    assert.isTrue(accepted, "the collection accepts the items");
    assert.equal(dropEffect, "copy");
    grid.drop(row, transfer);
    grid.endDrag();

    await until(
      () => destination.hasItem(first) && destination.hasItem(second),
      "the destination collection to receive the items",
      { observe: () => destination.getChildItems(true) },
    );
    assert.isTrue(grid.collection.hasItem(first));
    assert.isTrue(grid.collection.hasItem(second));
  });
});
