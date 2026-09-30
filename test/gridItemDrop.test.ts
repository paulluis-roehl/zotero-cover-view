import { assert } from "chai";

describe("grid item drops", function () {
  this.timeout(120000);

  function drag(
    win: _ZoteroTypes.MainWindow,
    target: Element,
    type: string,
    transfer: DataTransfer,
  ): DragEvent {
    const event = new win.Event(type, {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    target.dispatchEvent(event);
    return event;
  }

  it("reparents standalone notes dragged from grid tiles onto a regular tile", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const note = new Zotero.Item("note");
    try {
      collection.name = `Item drop ${Date.now()}`;
      await collection.saveTx();
      parent.setField("title", "Drop parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      note.setNote("Standalone source");
      note.addToCollection(collection.id);
      await note.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      await pane.selectItems([note.id]);
      const source = grid.querySelector(`[data-item-id="${note.id}"]`)!;
      const target = grid.querySelector(`[data-item-id="${parent.id}"]`)!;
      const transfer = new win.DataTransfer();
      drag(win, source, "dragstart", transfer);
      assert.isTrue(drag(win, target, "dragover", transfer).defaultPrevented);
      assert.equal(transfer.dropEffect, "move");
      assert.isTrue(drag(win, target, "drop", transfer).defaultPrevented);
      for (let i = 0; i < 100 && note.parentItemID !== parent.id; i++)
        await Zotero.Promise.delay(50);
      assert.equal(note.parentItemID, parent.id);
      await Zotero.Promise.delay(300);
      assert.isNull(grid.querySelector(`[data-item-id="${note.id}"]`));
    } finally {
      win.document.dispatchEvent(new win.Event("dragend"));
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (note.id) await note.eraseTx();
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("moves standalone attachments and children from another native source, preferring item flavor over files and text", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const destination = new Zotero.Collection();
    const sourceCollection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const oldParent = new Zotero.Item("book");
    const note = new Zotero.Item("note");
    const directory = `/tmp/opencode/grid-item-drop-${Zotero.Utilities.randomString()}`;
    const path = PathUtils.join(directory, "source.pdf");
    let standalone: Zotero.Item | undefined;
    let child: Zotero.Item | undefined;
    const dragDrop = (
      Zotero as typeof Zotero & {
        DragDrop: {
          currentDragSource: unknown;
          currentOrientation: number;
          currentDropEffect: string | null;
        };
      }
    ).DragDrop;
    const originalState = { ...dragDrop };
    try {
      await IOUtils.makeDirectory(directory);
      await IOUtils.write(path, new TextEncoder().encode("%PDF-1.4\n"));
      destination.name = `Drop destination ${Date.now()}`;
      await destination.saveTx();
      sourceCollection.name = `Drop source ${Date.now()}`;
      await sourceCollection.saveTx();
      parent.setField("title", "New parent");
      parent.addToCollection(destination.id);
      await parent.saveTx();
      oldParent.setField("title", "Old parent");
      oldParent.addToCollection(sourceCollection.id);
      await oldParent.saveTx();
      note.setNote("Child source");
      note.parentID = oldParent.id;
      await note.saveTx();
      standalone = await Zotero.Attachments.importFromFile({
        file: path,
        collections: [destination.id],
      });
      child = await Zotero.Attachments.linkFromFile({
        file: path,
        parentItemID: oldParent.id,
      });
      await pane.collectionsView!.selectByID(`C${sourceCollection.id}`);
      const sourceRow = (
        pane.itemsView as typeof pane.itemsView & {
          collectionTreeRows: unknown[];
        }
      ).collectionTreeRows[0];
      await pane.collectionsView!.selectByID(`C${destination.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      await pane.selectItems([standalone.id]);
      const transfer = new win.DataTransfer();
      drag(
        win,
        grid.querySelector(`[data-item-id="${standalone.id}"]`)!,
        "dragstart",
        transfer,
      );
      assert.include(Array.from(transfer.types), "application/x-moz-file");
      transfer.setData("text/plain", "Not an import");
      transfer.setData(
        "text/x-moz-url",
        "https://example.com/not-an-import.pdf",
      );
      const target = () => grid.querySelector(`[data-item-id="${parent.id}"]`)!;
      drag(win, target(), "dragover", transfer);
      assert.isTrue(
        transfer.effectAllowed === "all" ||
          transfer.effectAllowed === "uninitialized" ||
          transfer.effectAllowed.toLowerCase().includes(transfer.dropEffect),
        "Gecko must allow the operation requested by a parent tile",
      );
      // State from another native target must not turn this into a gap drop.
      dragDrop.currentOrientation = -1;
      dragDrop.currentDropEffect = "copy";
      assert.isTrue(drag(win, target(), "drop", transfer).defaultPrevented);
      for (
        let i = 0;
        i < 100 && !parent.getAttachments().includes(standalone.id);
        i++
      )
        await Zotero.Promise.delay(50);
      assert.equal(standalone.parentItemID, parent.id);
      assert.deepEqual(parent.getAttachments(), [standalone.id]);
      assert.isTrue(await IOUtils.exists(path));

      // Native payload from a different collection/view; children never need
      // to be rendered as grid tiles for the destination to receive them.
      const childrenTransfer = new win.DataTransfer();
      childrenTransfer.setData("zotero/item", `${note.id},${child.id}`);
      dragDrop.currentDragSource = sourceRow;
      assert.isTrue(
        drag(win, target(), "dragover", childrenTransfer).defaultPrevented,
      );
      assert.isTrue(
        drag(win, target(), "drop", childrenTransfer).defaultPrevented,
      );
      for (
        let i = 0;
        i < 100 && !parent.getAttachments().includes(child.id);
        i++
      )
        await Zotero.Promise.delay(50);
      assert.equal(note.parentItemID, parent.id);
      assert.equal(child.parentItemID, parent.id);
      assert.sameMembers(parent.getAttachments(), [standalone.id, child.id]);
      assert.isEmpty(oldParent.getAttachments());
      assert.isEmpty(oldParent.getNotes());
      await Zotero.Promise.delay(300);
      for (const item of [standalone, note, child])
        assert.isNull(grid.querySelector(`[data-item-id="${item.id}"]`));
    } finally {
      dragDrop.currentDragSource = originalState.currentDragSource;
      dragDrop.currentOrientation = originalState.currentOrientation;
      dragDrop.currentDropEffect = originalState.currentDropEffect;
      win.document.dispatchEvent(new win.Event("dragend"));
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of [standalone, child, note, oldParent, parent])
        if (item?.id) await item.eraseTx();
      for (const collection of [sourceCollection, destination])
        if (collection.id) await collection.eraseTx();
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  });

  it("rejects native-invalid item drops without changing parents, collections, or attachments", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const regular = new Zotero.Item("book");
    const standalone = new Zotero.Item("note");
    const existingChild = new Zotero.Item("note");
    const crossLibrary = new Zotero.Item("note");
    const annotation = new Zotero.Item("annotation");
    const directory = `/tmp/opencode/grid-item-rejection-${Zotero.Utilities.randomString()}`;
    const path = PathUtils.join(directory, "annotation-source.pdf");
    const group = new Zotero.Group({
      groupID: Date.now(),
      name: `Drop restrictions ${Date.now()}`,
      description: "",
      version: 0,
    });
    let attachment: Zotero.Item | undefined;
    const library = Zotero.Libraries.get(Zotero.Libraries.userLibraryID)!;
    const editableDescriptor = Object.getOwnPropertyDescriptor(
      library,
      "editable",
    );
    try {
      collection.name = `Invalid item drops ${Date.now()}`;
      await collection.saveTx();
      for (const item of [parent, regular]) {
        item.setField(
          "title",
          item === parent ? "Target" : "Invalid regular source",
        );
        item.addToCollection(collection.id);
        await item.saveTx();
      }
      standalone.setNote("Unchanged standalone source");
      standalone.addToCollection(collection.id);
      await standalone.saveTx();
      existingChild.setNote("Already under target");
      existingChild.parentID = parent.id;
      await existingChild.saveTx();
      group.editable = true;
      group.filesEditable = true;
      await group.saveTx();
      crossLibrary.libraryID = group.libraryID;
      crossLibrary.setNote("Other library");
      await crossLibrary.saveTx();
      await IOUtils.makeDirectory(directory);
      await IOUtils.write(path, new TextEncoder().encode("%PDF-1.4\n"));
      attachment = await Zotero.Attachments.linkFromFile({
        file: path,
        parentItemID: regular.id,
      });
      annotation.libraryID = attachment.libraryID;
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = "Do not reparent annotations";
      annotation.annotationComment = "";
      annotation.annotationColor = "#ffd400";
      annotation.annotationPageLabel = "1";
      annotation.annotationSortIndex = "00000|000000|00000";
      annotation.annotationPosition = JSON.stringify({
        pageIndex: 0,
        rects: [[0, 0, 10, 10]],
      });
      await annotation.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      const target = grid.querySelector(`[data-item-id="${parent.id}"]`)!;
      const snapshot = () =>
        [
          regular,
          standalone,
          existingChild,
          crossLibrary,
          annotation,
          attachment!,
        ].map((item) => ({
          id: item.id,
          parent: item.parentItemID,
          collections: item.getCollections(),
        }));
      const before = snapshot();
      const reject = (ids: number[], destination: Element = target) => {
        const transfer = new win.DataTransfer();
        // Include competing flavors even for rejected items: no import fallback.
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        transfer.mozSetDataAt("application/x-moz-file", file, 0);
        transfer.setData("text/plain", "Not an import");
        transfer.setData(
          "text/x-moz-url",
          "https://example.com/not-an-import.pdf",
        );
        transfer.setData("zotero/item", ids.join(","));
        assert.isFalse(
          drag(win, destination, "dragover", transfer).defaultPrevented,
        );
        assert.isFalse(destination.classList.contains("drop-target"));
        assert.isFalse(
          drag(win, destination, "drop", transfer).defaultPrevented,
        );
      };
      for (const item of [regular, annotation, crossLibrary, existingChild])
        reject([item.id]);
      // One invalid member rejects the whole payload before any mutation.
      for (const item of [regular, annotation, crossLibrary])
        reject([standalone.id, item.id]);
      reject([standalone.id], grid);
      reject(
        [regular.id],
        grid.querySelector(`[data-item-id="${standalone.id}"]`)!,
      );
      Object.defineProperty(library, "editable", {
        configurable: true,
        value: false,
      });
      reject([standalone.id]);
      if (editableDescriptor)
        Object.defineProperty(library, "editable", editableDescriptor);
      else delete (library as unknown as { editable?: boolean }).editable;
      // Revalidate at drop time even if the dragover was eligible.
      const changed = new win.DataTransfer();
      changed.setData("zotero/item", String(standalone.id));
      assert.isTrue(drag(win, target, "dragover", changed).defaultPrevented);
      changed.setData("zotero/item", String(regular.id));
      assert.isFalse(drag(win, target, "drop", changed).defaultPrevented);
      assert.isFalse(target.classList.contains("drop-target"));
      await Zotero.Promise.delay(300);
      assert.deepEqual(snapshot(), before);
      assert.isEmpty(parent.getAttachments());
      assert.deepEqual(parent.getNotes(), [existingChild.id]);
      assert.sameMembers(
        pane.itemsView.getSortedItems().map((item: Zotero.Item) => item.id),
        [parent.id, regular.id, standalone.id],
      );
    } finally {
      if (editableDescriptor)
        Object.defineProperty(library, "editable", editableDescriptor);
      else delete (library as unknown as { editable?: boolean }).editable;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of [
        annotation,
        attachment,
        existingChild,
        standalone,
        regular,
        parent,
      ])
        if (item?.id) await item.eraseTx();
      if (crossLibrary.id) await crossLibrary.eraseTx();
      if (group.libraryID) await group.eraseTx();
      if (collection.id) await collection.eraseTx();
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  });
});
