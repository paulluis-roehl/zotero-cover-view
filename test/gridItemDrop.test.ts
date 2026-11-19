import { assert } from "chai";
import {
  createCollection,
  createGroup,
  createItems,
  DragTarget,
  GridFixture,
  ItemRef,
  ItemSpec,
  onTeardown,
  openGrid,
  standaloneNote,
  track,
  until,
} from "./helpers/gridFixture";
import { pdfBytes, scratchFile } from "./helpers/testEnvironment";

function childNote(parent: Zotero.Item): ItemSpec {
  return {
    itemType: "note",
    setup: (note) => {
      note.setNote("Child note");
      note.parentID = parent.id;
    },
  };
}

/** Add file and text flavours that a drop must not import instead. */
function addCompetingFlavours(transfer: DataTransfer, path: string): void {
  transfer.mozSetDataAt(
    "application/x-moz-file",
    Zotero.File.pathToFile(path),
    0,
  );
  transfer.setData("text/plain", "Not an import");
  transfer.setData("text/x-moz-url", "https://example.com/not-an-import.pdf");
}

/** Parents and collections of `items`, to compare before and after a drop. */
function placement(items: Zotero.Item[]) {
  return items.map((item) => ({
    id: item.id,
    parent: item.parentItemID,
    collections: item.getCollections(),
  }));
}

describe("grid item drops", function () {
  this.timeout(30000);

  it("reparents a standalone note dragged from its tile onto a regular tile", async function () {
    const grid = await openGrid({ items: [{}, standaloneNote] });
    const [parent, note] = grid.items;
    await grid.select([note]);

    const { accepted, dropEffect, transfer } = grid.drag(note, parent);
    assert.isTrue(accepted);
    assert.equal(dropEffect, "move");
    assert.include(
      ["move", "copyMove", "linkMove", "all"],
      transfer.effectAllowed,
      "the drag allows moving",
    );
    await until(
      () => note.parentItemID === parent.id,
      "the note to become a child of the parent",
    );
    await grid.showsItems([parent]);
    assert.isNull(grid.findTile(note), "the note's tile is gone");
  });

  it("reparents a standalone attachment by item rather than by file or text", async function () {
    const grid = await openGrid({ items: 1 });
    const [parent] = grid.items;
    const path = await scratchFile("standalone.pdf", pdfBytes());
    const [attachment] = track(
      await Zotero.Attachments.importFromFile({
        file: path,
        collections: [grid.collection.id],
      }),
    );
    await grid.showsItems([attachment]);
    await grid.select([attachment]);

    const transfer = grid.startDrag(attachment)!;
    assert.include(Array.from(transfer.types), "application/x-moz-file");
    addCompetingFlavours(transfer, path);
    assert.isTrue(grid.dragOver(parent, transfer).accepted);
    assert.isTrue(grid.drop(parent, transfer));
    grid.endDrag();

    await until(
      () => parent.getAttachments().includes(attachment.id),
      "the attachment to become a child of the parent",
    );
    assert.deepEqual(parent.getAttachments(), [attachment.id]);
    assert.isTrue(await IOUtils.exists(path), "the source file is kept");
    await grid.showsItems([parent]);
    assert.isNull(grid.findTile(attachment), "the attachment's tile is gone");
  });

  it("reparents children dragged from another collection's view", async function () {
    const grid = await openGrid({ items: 1 });
    const [parent] = grid.items;
    const elsewhere = await createCollection();
    const [oldParent] = await createItems(1, elsewhere);
    const [note] = await createItems([childNote(oldParent)]);
    const path = await scratchFile("child.pdf", pdfBytes());
    const child = await Zotero.Attachments.linkFromFile({
      file: path,
      parentItemID: oldParent.id,
    });
    track(child);

    const transfer = grid.itemTransfer([note, child]);
    // Passing over the collection tree leaves its drop orientation behind.
    grid.dragOver(grid.collectionRow(elsewhere), transfer);
    assert.isTrue(grid.dragOver(parent, transfer).accepted);
    assert.isTrue(grid.drop(parent, transfer));
    grid.endDrag();

    await until(
      () =>
        parent.getNotes().includes(note.id) &&
        parent.getAttachments().includes(child.id) &&
        !oldParent.getNotes().length &&
        !oldParent.getAttachments().length,
      "the children to move to the parent",
      { observe: () => placement([note, child]) },
    );
  });

  describe("rejecting", function () {
    let grid: GridFixture;
    let parent: Zotero.Item;
    let regular: Zotero.Item;
    let note: Zotero.Item;
    let otherNote: Zotero.Item;
    let existingChild: Zotero.Item;
    let annotation: Zotero.Item;
    let path: string;

    beforeEach(async function () {
      grid = await openGrid({
        items: [{}, {}, standaloneNote, standaloneNote],
      });
      [parent, regular, note, otherNote] = grid.items;
      [existingChild] = await createItems([childNote(parent)]);
      path = await scratchFile("annotated.pdf", pdfBytes());
      const attachment = await Zotero.Attachments.linkFromFile({
        file: path,
        parentItemID: regular.id,
      });
      track(attachment);
      annotation = new Zotero.Item("annotation");
      annotation.libraryID = attachment.libraryID;
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = "Highlighted text";
      annotation.annotationComment = "";
      annotation.annotationColor = "#ffd400";
      annotation.annotationPageLabel = "1";
      annotation.annotationSortIndex = "00000|000000|00000";
      annotation.annotationPosition = JSON.stringify({
        pageIndex: 0,
        rects: [[0, 0, 10, 10]],
      });
      track(annotation);
      await annotation.saveTx();
    });

    /** Drag `items` over `target`, drop them, and expect both refused. */
    async function expectRejected(
      items: ItemRef[],
      target: DragTarget = parent,
    ): Promise<void> {
      const watched = [regular, note, otherNote, existingChild, annotation];
      const before = placement(watched);
      const transfer = grid.itemTransfer(items);
      addCompetingFlavours(transfer, path);
      assert.isFalse(grid.dragOver(target, transfer).accepted, "hover");
      assert.isFalse(grid.drop(target, transfer), "drop");
      grid.endDrag();
      await grid.settled();
      assert.deepEqual(placement(watched), before);
      assert.isEmpty(parent.getAttachments());
      assert.deepEqual(parent.getNotes(), [existingChild.id]);
    }

    it("refuses a regular item", async function () {
      await expectRejected([regular]);
    });

    it("refuses an annotation", async function () {
      await expectRejected([annotation]);
    });

    it("refuses an item already under the target", async function () {
      await expectRejected([existingChild]);
    });

    it("refuses a note from another library", async function () {
      const group = await createGroup();
      const [crossLibrary] = await createItems(
        [standaloneNote],
        await createCollection(undefined, group.libraryID),
      );
      await expectRejected([crossLibrary]);
      await expectRejected([note, crossLibrary]);
    });

    it("refuses a payload with one invalid member", async function () {
      await expectRejected([note, regular]);
      await expectRejected([note, annotation]);
    });

    it("refuses drops on whitespace and on non-regular tiles", async function () {
      await expectRejected([note], "whitespace");
      await expectRejected([otherNote], note);
    });

    it("refuses a non-regular tile hovered after a regular one", async function () {
      const transfer = grid.itemTransfer([otherNote]);
      assert.isTrue(grid.dragOver(parent, transfer).accepted, "regular tile");
      const refused = grid.dragOver(note, transfer);
      assert.isFalse(refused.accepted, "non-regular tile");
      assert.equal(refused.dropEffect, "none");
      assert.isFalse(grid.drop(note, transfer), "drop");
      grid.endDrag();
      await grid.settled();
      assert.isNotOk(otherNote.parentItemID);
      assert.isNotOk(note.parentItemID);
      assert.deepEqual(parent.getNotes(), [existingChild.id]);
    });

    it("refuses data changed between hover and drop", async function () {
      const transfer = grid.itemTransfer([note]);
      assert.isTrue(grid.dragOver(parent, transfer).accepted);
      transfer.setData("zotero/item", String(regular.id));
      assert.isFalse(grid.drop(parent, transfer));
      grid.endDrag();
      await grid.settled();
      assert.isNotOk(regular.parentItemID);
      assert.deepEqual(parent.getNotes(), [existingChild.id]);
    });
  });

  it("refuses drops in a read-only library", async function () {
    const group = await createGroup();
    const grid = await openGrid({
      items: [{}, standaloneNote],
      libraryID: group.libraryID,
    });
    const [parent, note] = grid.items;
    group.editable = false;
    await group.saveTx();
    onTeardown(async () => {
      group.editable = true;
      await group.saveTx();
    });

    const transfer = grid.itemTransfer([note]);
    assert.isFalse(grid.dragOver(parent, transfer).accepted);
    assert.isFalse(grid.drop(parent, transfer));
    grid.endDrag();
    await grid.settled();
    assert.isNotOk(note.parentItemID);
  });

  describe("drop target highlight", function () {
    for (const selected of [false, true])
      it(`highlights ${selected ? "a selected" : "an unselected"} tile only while data can be dropped on it`, async function () {
        const grid = await openGrid({ items: [{}, standaloneNote] });
        const [parent, note] = grid.items;
        grid.focusGrid();
        await grid.select(selected ? [parent] : []);
        const background = () =>
          grid.win.getComputedStyle(grid.tile(parent))!.backgroundColor;
        const baseline = background();
        const transfer = grid.itemTransfer([note]);
        const caption = grid.tile(parent).querySelector("figcaption")!;

        grid.dragOver(caption, transfer);
        const highlight = background();
        assert.notEqual(highlight, baseline, "hovering highlights the tile");
        grid.dragLeave(grid.tile(parent), caption);
        assert.equal(background(), highlight, "moving within the tile");
        grid.dragOver("whitespace", transfer);
        assert.equal(background(), baseline, "moving to whitespace");

        grid.dragOver(parent, transfer);
        grid.dragOver(note, transfer);
        assert.equal(background(), baseline, "moving to a refusing tile");

        grid.dragOver(parent, transfer);
        grid.dragLeave(parent, null);
        assert.equal(background(), baseline, "leaving the window");

        grid.dragOver(parent, transfer);
        grid.scroll(0);
        assert.equal(background(), baseline, "scrolling");

        grid.dragOver(parent, transfer);
        assert.notEqual(background(), baseline);
        grid.drop(parent, transfer);
        assert.equal(background(), baseline, "dropping");
        grid.endDrag();
        await until(
          () => note.parentItemID === parent.id,
          "the note to become a child of the parent",
        );
      });
  });
});
