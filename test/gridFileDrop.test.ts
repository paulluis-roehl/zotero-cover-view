import { assert } from "chai";
import {
  createCollection,
  createGroup,
  createSavedSearch,
  DragTarget,
  GridFixture,
  Modifiers,
  onTeardown,
  openGrid,
  patch,
  setAppPref,
  setSyncedSetting,
  standaloneNote,
  track,
  until,
} from "./helpers/gridFixture";
import {
  pdfBytes,
  scratchDirectory,
  scratchFile,
} from "./helpers/testEnvironment";

const move: Modifiers = Zotero.isMac ? { meta: true } : { shift: true };
const link: Modifiers = Zotero.isMac
  ? { meta: true, alt: true }
  : { shift: true, ctrl: true };

interface FileGrid extends GridFixture {
  /** IDs of items submitted for metadata recognition. */
  recognized: number[];
}

/**
 * Open a grid whose collection receives file drops. Recognition is recorded
 * instead of run, and items imported into the collection are erased when the
 * test ends.
 */
async function openFileGrid(
  options: Parameters<typeof openGrid>[0] = {},
): Promise<FileGrid> {
  const grid = Object.assign(await openGrid(options), {
    recognized: [] as number[],
  });
  const recognition = (
    Zotero as unknown as {
      RecognizeDocument: { autoRecognizeItems(items: Zotero.Item[]): void };
    }
  ).RecognizeDocument;
  patch(recognition, "autoRecognizeItems", (items: Zotero.Item[]) => {
    grid.recognized.push(...items.map((item) => item.id));
  });
  onTeardown(() => Zotero.Items.erase(imported(grid).map((item) => item.id)));
  return grid;
}

/** Items in the grid's collection that the test did not create there. */
function imported(grid: GridFixture): Zotero.Item[] {
  if (!Zotero.Collections.get(grid.collection.id)) return [];
  const own = new Set(grid.items.map((item) => item.id));
  return grid.collection.getChildItems().filter((item) => !own.has(item.id));
}

/** Wait until `count` items have been imported into the grid's collection. */
function importsInto(grid: GridFixture, count = 1): Promise<Zotero.Item[]> {
  return until(
    () => {
      const items = imported(grid);
      return items.length >= count ? items : undefined;
    },
    `${count} item(s) to be imported into the collection`,
    { observe: () => imported(grid).map((item) => item.id) },
  );
}

/** Whether an item's data is loaded, which it is not yet while being saved. */
function isLoaded(item: Zotero.Item): boolean {
  try {
    item.getField("title");
    return true;
  } catch {
    return false;
  }
}

/** Wait until `parent` has `count` loaded attachments and return them. */
async function attachmentsOf(
  parent: Zotero.Item,
  count = 1,
): Promise<Zotero.Item[]> {
  return until(
    () => {
      const attachments = Zotero.Items.get(parent.getAttachments());
      return attachments.length >= count && attachments.every(isLoaded)
        ? attachments
        : undefined;
    },
    `${count} attachment(s) to be added to the parent`,
    { observe: () => parent.getAttachments() },
  );
}

/** Whether a file exists, read synchronously so that `until` can poll it. */
function fileExists(path: string): boolean {
  return !!path && Zotero.File.pathToFile(path).exists();
}

/** Drop `transfer` on `target` after hovering it, expecting both to succeed. */
function dropAccepted(
  grid: GridFixture,
  target: DragTarget,
  transfer: DataTransfer,
  modifiers: Modifiers = {},
): void {
  assert.isTrue(grid.dragOver(target, transfer, modifiers).accepted, "hover");
  assert.isTrue(grid.drop(target, transfer, modifiers), "drop");
  grid.endDrag();
}

/** Hover and drop `transfer` on `target`, expecting both to be refused. */
async function dropRefused(
  grid: GridFixture,
  target: DragTarget,
  transfer: DataTransfer,
): Promise<void> {
  assert.isFalse(grid.dragOver(target, transfer).accepted, "hover");
  assert.isFalse(grid.drop(target, transfer), "drop");
  grid.endDrag();
  await grid.settled();
}

/**
 * Data as Gecko exposes some external drags: an object offering one file
 * entry, made by `entry`, under these flavours.
 */
function geckoTransfer(
  entry: () => unknown,
  types = ["application/x-moz-file", "text/x-moz-url", "Files"],
): DataTransfer {
  return {
    types,
    mozItemCount: 1,
    mozGetDataAt: (type: string) =>
      type === "application/x-moz-file" ? entry() : null,
    getData: () => "",
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

describe("grid file drops", function () {
  this.timeout(30000);

  it("imports a file dropped on whitespace as a standalone attachment of the collection", async function () {
    const grid = await openFileGrid({ items: 1 });
    const [parent] = grid.items;
    const path = await scratchFile("standalone.pdf", pdfBytes());

    dropAccepted(grid, "whitespace", grid.fileTransfer([path]));

    const [attachment] = await importsInto(grid);
    assert.isTrue(attachment.isPDFAttachment());
    assert.isNotOk(attachment.parentItemID);
    assert.equal(
      attachment.attachmentLinkMode,
      Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
    );
    assert.isEmpty(parent.getAttachments());
    await until(
      () => grid.recognized.includes(attachment.id),
      "the attachment to be submitted for recognition",
      { observe: () => grid.recognized },
    );
    assert.isTrue(await IOUtils.exists(path), "copying keeps the source");
  });

  it("imports a file dropped on whitespace of My Library outside any collection", async function () {
    const grid = await openFileGrid({ items: 1 });
    const [parent] = grid.items;
    await grid.showRow(`L${Zotero.Libraries.userLibraryID}`, [parent]);
    const path = await scratchFile("library.pdf", pdfBytes());

    dropAccepted(grid, "whitespace", grid.fileTransfer([path]));

    const [attachment] = await until(() => {
      const added = Zotero.Items.get(grid.recognized);
      return added.length ? track(...added) : undefined;
    }, "the dropped file to be imported");
    assert.isTrue(attachment.isPDFAttachment());
    assert.isNotOk(attachment.parentItemID);
    assert.isEmpty(attachment.getCollections());
  });

  it("attaches a file dropped on a tile to its item and selects the new attachment", async function () {
    const grid = await openFileGrid({ items: 2 });
    const [parent] = grid.items;
    const path = await scratchFile("child.pdf", pdfBytes());
    const transfer = grid.fileTransfer([path]);
    const caption = grid.tile(parent).querySelector("figcaption")!;

    assert.isTrue(grid.dragOver(caption, transfer).accepted, "hover");
    assert.isTrue(grid.drop(parent, transfer), "drop");
    grid.endDrag();

    const [child] = await attachmentsOf(parent);
    assert.equal(
      child.attachmentLinkMode,
      Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
    );
    assert.isEmpty(child.getCollections());
    assert.isEmpty(imported(grid), "nothing is imported standalone");
    await until(
      () => grid.selectedItems().join() === String(child.id),
      "the new attachment to become the native selection",
      { observe: () => grid.selectedItems() },
    );
    assert.notInclude(grid.recognized, child.id, "it is not recognized");
    assert.isTrue(await IOUtils.exists(path), "copying keeps the source");
  });

  describe("modifiers", function () {
    for (const onTile of [false, true]) {
      const where = onTile ? "on a tile" : "on whitespace";

      it(`moves a file dropped ${where} with the move modifier`, async function () {
        const grid = await openFileGrid({ items: 1 });
        const [parent] = grid.items;
        const path = await scratchFile("moved.pdf", pdfBytes());

        dropAccepted(
          grid,
          onTile ? parent : "whitespace",
          grid.fileTransfer([path]),
          move,
        );

        const [attachment] = onTile
          ? await attachmentsOf(parent)
          : await importsInto(grid);
        assert.equal(
          attachment.attachmentLinkMode,
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        );
        await until(
          () => fileExists(attachment.getFilePath() || ""),
          "the attachment's file to exist",
        );
        await until(() => !fileExists(path), "the source to be removed");
      });

      it(`links a file dropped ${where} with the link modifier`, async function () {
        const grid = await openFileGrid({ items: 1 });
        const [parent] = grid.items;
        const path = await scratchFile("linked.pdf", pdfBytes());

        dropAccepted(
          grid,
          onTile ? parent : "whitespace",
          grid.fileTransfer([path]),
          link,
        );

        const [attachment] = onTile
          ? await attachmentsOf(parent)
          : await importsInto(grid);
        assert.equal(
          attachment.attachmentLinkMode,
          Zotero.Attachments.LINK_MODE_LINKED_FILE,
        );
        await until(
          () => fileExists(attachment.getFilePath() || ""),
          "the attachment's file to exist",
        );
        assert.isTrue(await IOUtils.exists(path), "the source is kept");
      });

      it(`keeps a moved file whose import ${where} failed`, async function () {
        const grid = await openFileGrid({ items: 1 });
        const [parent] = grid.items;
        const target: DragTarget = onTile ? parent : "whitespace";
        const path = await scratchFile("failing.pdf", pdfBytes());
        const later = await scratchFile("later.pdf", pdfBytes());
        let attempted = false;
        const importFromFile: typeof Zotero.Attachments.importFromFile = patch(
          Zotero.Attachments,
          "importFromFile",
          async (options) => {
            if (options.file !== path)
              return importFromFile.call(Zotero.Attachments, options);
            attempted = true;
            throw new Error("Simulated import failure");
          },
        );

        dropAccepted(grid, target, grid.fileTransfer([path]), move);
        await until(() => attempted, "the import to be attempted");
        // Once a later drop has been imported, the failed one has finished.
        dropAccepted(grid, target, grid.fileTransfer([later]));
        await (onTile ? attachmentsOf(parent) : importsInto(grid));

        if (onTile) assert.lengthOf(parent.getAttachments(), 1);
        else assert.lengthOf(imported(grid), 1);
        assert.isTrue(await IOUtils.exists(path), "the source is kept");
      });
    }
  });

  describe("naming", function () {
    beforeEach(async function () {
      setAppPref("extensions.zotero.autoRenameFiles", true);
      await setSyncedSetting(
        Zotero.Libraries.userLibraryID,
        "attachmentRenameTemplate",
        "{{ title }}",
      );
    });

    it("renames a single file dropped on a tile after its item", async function () {
      const grid = await openFileGrid({
        items: [{ title: "Renamed after its parent" }],
      });
      const [parent] = grid.items;
      const path = await scratchFile("single.pdf", pdfBytes());

      dropAccepted(grid, parent, grid.fileTransfer([path]));

      const [child] = await attachmentsOf(parent);
      await until(
        () => child.attachmentFilename === "Renamed after its parent.pdf",
        "the attachment's file to be named after its parent",
        { observe: () => child.attachmentFilename },
      );
    });

    it("keeps the names of several files dropped on a tile and titles them after the files", async function () {
      const grid = await openFileGrid({ items: 1 });
      const [parent] = grid.items;
      const paths = [
        await scratchFile("first.pdf", pdfBytes()),
        await scratchFile("second.pdf", pdfBytes()),
      ];

      dropAccepted(grid, parent, grid.fileTransfer(paths));

      const children = await attachmentsOf(parent, 2);
      const named = () =>
        children
          .map((child) => [child.attachmentFilename, child.getField("title")])
          .sort();
      await until(
        () =>
          JSON.stringify(named()) ===
          JSON.stringify([
            ["first.pdf", "first"],
            ["second.pdf", "second"],
          ]),
        "the attachments to keep their file names and be titled after them",
        { observe: named },
      );
      await until(
        () =>
          grid.selectedItems().length === 2 &&
          children.every((child) => grid.selectedItems().includes(child.id)),
        "the new attachments to become the native selection",
        { observe: () => grid.selectedItems() },
      );
    });
  });

  it("does not retarget a stationary pointer when sorting moves another tile under it", async function () {
    const grid = await openFileGrid({
      items: [{ title: "Zulu parent" }, { title: "Middle parent" }],
    });
    const [moving, other] = grid.items;
    assert.deepEqual(
      grid.displayedItems(),
      [other.id, moving.id],
      "items are sorted by title",
    );
    const path = await scratchFile("stationary.pdf", pdfBytes());
    const transfer = grid.fileTransfer([path]);
    assert.isTrue(grid.dragOver(moving, transfer).accepted);
    const slot = grid.tile(moving).getBoundingClientRect();

    moving.setField("title", "Alpha parent");
    await moving.saveTx();
    await until(() => {
      const rect = grid.findTile(other)?.getBoundingClientRect();
      return (
        rect &&
        Math.abs(rect.left - slot.left) < 1 &&
        Math.abs(rect.top - slot.top) < 1
      );
    }, "the other tile to take the renamed item's place");

    // The other tile now lies under the pointer left at the moved tile's centre.
    assert.isFalse(grid.dragOver(other, transfer).accepted, "hover");
    assert.isFalse(grid.drop(other, transfer), "drop");
    grid.endDrag();

    dropAccepted(grid, moving, transfer);
    await attachmentsOf(moving);
    assert.isEmpty(other.getAttachments());
  });

  describe("Gecko transfers", function () {
    it("imports a file dragged with a file URL, as from Dolphin", async function () {
      const grid = await openFileGrid();
      const path = await scratchFile("dolphin.pdf", pdfBytes());
      const transfer = grid.fileTransfer([path]);
      transfer.mozSetDataAt("text/x-moz-url", `file://${path}`, 0);

      dropAccepted(grid, "whitespace", transfer);

      const [attachment] = await importsInto(grid);
      assert.isTrue(attachment.isPDFAttachment());
    });

    it("imports a file exposed only through a wrapper until queried", async function () {
      const grid = await openFileGrid();
      const path = await scratchFile("wrapped.pdf", pdfBytes());
      const file = Zotero.File.pathToFile(path);
      const wrapped: Record<string, unknown> = {
        QueryInterface: () => {
          Object.assign(wrapped, {
            path: file.path,
            isFile: () => true,
            isDirectory: () => false,
          });
          return file;
        },
      };

      dropAccepted(
        grid,
        "whitespace",
        geckoTransfer(() => wrapped),
      );

      const [attachment] = await importsInto(grid);
      assert.isTrue(attachment.isPDFAttachment());
    });

    it("accepts a file hidden until the drop", async function () {
      const grid = await openFileGrid();
      const path = await scratchFile("hidden.pdf", pdfBytes());
      let exposed = false;
      const transfer = geckoTransfer(() => {
        if (!exposed) throw new Error("Files are not exposed while hovering");
        return Zotero.File.pathToFile(path);
      });

      assert.isTrue(grid.dragOver("whitespace", transfer).accepted, "hover");
      exposed = true;
      assert.isTrue(grid.drop("whitespace", transfer), "drop");
      grid.endDrag();

      const [attachment] = await importsInto(grid);
      assert.isTrue(attachment.isPDFAttachment());
    });

    it("imports nothing from a directory, mixed or empty data", async function () {
      const grid = await openFileGrid({ items: 1 });
      const [parent] = grid.items;
      const directory = await scratchDirectory();
      const path = await scratchFile("mixed.pdf", pdfBytes());
      const mixed = grid.fileTransfer([path]);
      mixed.setData("zotero/item", String(parent.id));

      for (const target of ["whitespace", parent] as DragTarget[]) {
        grid.dragOver(target, grid.fileTransfer([directory]));
        grid.drop(target, grid.fileTransfer([directory]));
        grid.endDrag();
        await dropRefused(grid, target, mixed);
        await dropRefused(grid, target, new grid.win.DataTransfer());
      }

      await grid.settled();
      assert.isEmpty(imported(grid));
      assert.isEmpty(parent.getAttachments());
    });
  });

  describe("restricted targets", function () {
    it("refuses files on note and attachment tiles", async function () {
      const grid = await openFileGrid({ items: [{}, standaloneNote] });
      const [, note] = grid.items;
      const path = await scratchFile("refused.pdf", pdfBytes());
      const [attachment] = track(
        await Zotero.Attachments.importFromFile({
          file: path,
          collections: [grid.collection.id],
        }),
      );
      grid.items.push(attachment);
      await grid.showsItems([attachment]);

      for (const target of [note, attachment])
        await dropRefused(grid, target, grid.fileTransfer([path]));

      assert.isEmpty(imported(grid));
    });

    it("refuses files in a saved search", async function () {
      const grid = await openFileGrid({ items: 1 });
      const [parent] = grid.items;
      const search = await createSavedSearch(grid.collection);
      await grid.showRow(`S${search.id}`, [parent]);
      const path = await scratchFile("search.pdf", pdfBytes());

      for (const target of ["whitespace", parent] as DragTarget[])
        await dropRefused(grid, target, grid.fileTransfer([path]));

      assert.isEmpty(parent.getAttachments());
      assert.isEmpty(imported(grid));
    });

    for (const permission of ["editable", "filesEditable"] as const)
      it(`refuses files on tiles in a group that is not ${permission}`, async function () {
        const group = await createGroup();
        const grid = await openFileGrid({
          items: 1,
          libraryID: group.libraryID,
        });
        const [parent] = grid.items;
        group[permission] = false;
        await group.saveTx();
        onTeardown(async () => {
          group[permission] = true;
          await group.saveTx();
        });
        const path = await scratchFile("group.pdf", pdfBytes());

        const targets: DragTarget[] =
          permission === "editable" ? ["whitespace", parent] : [parent];
        for (const target of targets)
          await dropRefused(grid, target, grid.fileTransfer([path]));

        assert.isEmpty(parent.getAttachments());
        assert.isEmpty(imported(grid));
      });
  });

  describe("collection changes", function () {
    for (const onTile of [false, true])
      it(`does not drop ${onTile ? "on a tile" : "on whitespace"} hovered in a collection that is no longer shown`, async function () {
        const grid = await openFileGrid({ items: 1 });
        const [parent] = grid.items;
        const other = await createCollection();
        parent.addToCollection(other.id);
        await parent.saveTx();
        const path = await scratchFile("pending.pdf", pdfBytes());
        const transfer = grid.fileTransfer([path]);
        const target: DragTarget = onTile ? parent : "whitespace";

        assert.isTrue(grid.dragOver(target, transfer).accepted);
        await grid.showRow(`C${other.id}`, [parent]);
        assert.isFalse(grid.drop(target, transfer));
        grid.endDrag();
        await grid.settled();

        assert.isEmpty(parent.getAttachments());
        assert.deepEqual(other.getChildItems(true), [parent.id]);
        assert.isEmpty(imported(grid));
      });

    it("refuses drops while the item tree still shows the previous collection", async function () {
      const grid = await openFileGrid({ items: 1 });
      const [parent] = grid.items;
      const other = await createCollection();
      parent.addToCollection(other.id);
      await parent.saveTx();
      const itemsView = grid.pane.itemsView as _ZoteroTypes.ItemTree & {
        collectionTreeRows: unknown[];
        changeCollectionTreeRows(rows: unknown[]): Promise<void>;
      };
      const previousRows = [...itemsView.collectionTreeRows];
      await grid.showRow(`C${other.id}`, [parent]);
      const requestedRows = [...itemsView.collectionTreeRows];
      onTeardown(() => itemsView.changeCollectionTreeRows(requestedRows));
      // Zotero's own API makes the tree lag behind the selected collection.
      await itemsView.changeCollectionTreeRows(previousRows);
      const path = await scratchFile("lagging.pdf", pdfBytes());

      await dropRefused(grid, "whitespace", grid.fileTransfer([path]));

      assert.isEmpty(imported(grid));
      assert.deepEqual(other.getChildItems(true), [parent.id]);
    });
  });
});
