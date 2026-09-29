import { assert } from "chai";
import { ItemTreeBridge } from "../src/modules/itemTreeBridge";

describe("grid whitespace file drops", function () {
  this.timeout(120000);

  function drag(
    win: _ZoteroTypes.MainWindow,
    target: Element,
    type: string,
    transfer: DataTransfer,
    modifiers: {
      shiftKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
    } = {},
  ): DragEvent {
    const event = new win.Event(type, {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    for (const [key, value] of Object.entries(modifiers)) {
      Object.defineProperty(event, key, { value });
    }
    target.dispatchEvent(event);
    return event;
  }

  function fileTransfer(path: string): DataTransfer {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return {
      types: ["application/x-moz-file", "Files"],
      mozItemCount: 1,
      mozGetDataAt: (type: string) =>
        type === "application/x-moz-file" ? file : null,
      dropEffect: "copy",
    } as unknown as DataTransfer;
  }

  it("imports a file as a standalone attachment into the selected collection via Zotero", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originalHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-import-${Zotero.Utilities.randomString()}.pdf`,
    );
    const bridge = new ItemTreeBridge(win);
    const nativeItemsView = pane.itemsView as typeof pane.itemsView & {
      onDrop: (event: DragEvent, row: number) => Promise<void>;
    };
    const originalOnDrop = nativeItemsView.onDrop;
    const recognize =
      Zotero.RecognizeDocument as typeof Zotero.RecognizeDocument & {
        autoRecognizeItems: (items: Zotero.Item[]) => void;
      };
    const originalRecognize = recognize.autoRecognizeItems;
    let recognized: Zotero.Item[] = [];
    let imported: Zotero.Item | undefined;
    try {
      // A minimal PDF so Zotero detects the document type for recognition.
      const content =
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
      await IOUtils.write(path, new TextEncoder().encode(content));
      collection.name = `Grid import ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      recognize.autoRecognizeItems = (items) => {
        recognized = items;
      };
      // Build a Gecko transfer with the two flavors reported by Dolphin.
      const transfer = new win.DataTransfer();
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      transfer.mozSetDataAt("application/x-moz-file", file, 0);
      transfer.mozSetDataAt("text/x-moz-url", `file://${path}`, 0);
      assert.isTrue(
        bridge.canDropFiles(transfer),
        "Dolphin's file + URL flavors must still import the local PDF",
      );
      const over = drag(win, grid, "dragover", transfer);
      assert.isTrue(over.defaultPrevented);
      // Observe completion without replacing the native implementation.
      let completed: Promise<void> | undefined;
      nativeItemsView.onDrop = (event, row) => {
        completed = originalOnDrop.call(nativeItemsView, event, row);
        return completed;
      };
      const drop = drag(win, grid, "drop", transfer);
      assert.isTrue(drop.defaultPrevented);
      assert.isDefined(completed);
      await completed;
      assert.lengthOf(recognized, 1);
      imported = recognized[0];
      assert.isTrue(imported.isAttachment());
      assert.isTrue(imported.isPDFAttachment());
      assert.isNotOk(imported.parentItemID);
      assert.isTrue(collection.hasItem(imported.id));
      assert.isTrue(await IOUtils.exists(path), "copy retains the source");
    } finally {
      nativeItemsView.onDrop = originalOnDrop;
      recognize.autoRecognizeItems = originalRecognize;
      bridge.destroy();
      if (grid.hidden !== originalHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (imported?.id) await imported.eraseTx();
      if (collection.id) await collection.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("rejects invalid data and drops on tiles without calling the native importer", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originalHidden = grid.hidden;
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-reject-${Zotero.Utilities.randomString()}.txt`,
    );
    const bridge = new ItemTreeBridge(win);
    const view = pane.itemsView as typeof pane.itemsView & {
      onDrop: (event: DragEvent, row: number) => Promise<void>;
    };
    const originalOnDrop = view.onDrop;
    let calls = 0;
    try {
      await IOUtils.write(path, new TextEncoder().encode("reject fixture"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      view.onDrop = async () => {
        calls++;
      };
      const valid = fileTransfer(path);
      assert.isTrue(bridge.canDropFiles(valid), "library root accepts files");
      const descriptor = Object.getOwnPropertyDescriptor(
        view,
        "collectionTreeRows",
      );
      const rows = view.collectionTreeRows as Array<{
        ref: { libraryID: number };
        isCollection(): boolean;
        isLibrary(root?: boolean): boolean;
      }>;
      try {
        for (const invalidRows of [
          [],
          [
            rows[0],
            {
              ref: { libraryID: rows[0].ref.libraryID + 1000000 },
              isCollection: () => true,
              isLibrary: () => false,
            },
          ],
          [
            {
              ref: rows[0].ref,
              isCollection: () => false,
              isLibrary: () => false,
            },
          ],
        ]) {
          Object.defineProperty(view, "collectionTreeRows", {
            configurable: true,
            value: invalidRows,
          });
          assert.isFalse(bridge.canDropFiles(valid));
          drag(win, grid, "drop", valid);
        }
      } finally {
        if (descriptor)
          Object.defineProperty(view, "collectionTreeRows", descriptor);
        else
          delete (view as { collectionTreeRows?: unknown }).collectionTreeRows;
      }
      const mixed = Object.assign({}, valid, {
        types: ["application/x-moz-file", "zotero/item"],
      }) as DataTransfer;
      const directory = fileTransfer(Zotero.DataDirectory.dir);
      for (const transfer of [mixed, directory, {} as DataTransfer]) {
        assert.isFalse(bridge.canDropFiles(transfer));
        drag(win, grid, "drop", transfer);
      }
      const tile = win.document.createElement("figure");
      tile.className = "grid-view-item";
      grid.append(tile);
      try {
        assert.isFalse(drag(win, tile, "drop", valid).defaultPrevented);
      } finally {
        tile.remove();
      }
      assert.equal(calls, 0);
      assert.isTrue(await IOUtils.exists(path));
    } finally {
      view.onDrop = originalOnDrop;
      bridge.destroy();
      if (grid.hidden !== originalHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("uses native move/link modifiers and never deletes a source after a failed import", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const view = pane.itemsView as typeof pane.itemsView & {
      onDrop: (event: DragEvent, row: number) => Promise<void>;
    };
    const originalDrop = view.onDrop;
    const originalImport = Zotero.Attachments.importFromFile;
    const recognize =
      Zotero.RecognizeDocument as typeof Zotero.RecognizeDocument & {
        autoRecognizeItems: (items: Zotero.Item[]) => void;
      };
    const originalRecognize = recognize.autoRecognizeItems;
    const paths: string[] = [];
    const imported: Zotero.Item[] = [];
    let completed: Promise<void> | undefined;
    try {
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      recognize.autoRecognizeItems = (items) => imported.push(...items);
      view.onDrop = (event, row) => {
        completed = originalDrop.call(view, event, row);
        return completed;
      };
      for (const action of ["move", "link", "failure"] as const) {
        const path = PathUtils.join(
          Zotero.DataDirectory.dir,
          `cover-view-${action}-${Zotero.Utilities.randomString()}.txt`,
        );
        paths.push(path);
        await IOUtils.write(path, new TextEncoder().encode(action));
        const transfer = fileTransfer(path);
        const modifiers = win.navigator.platform.startsWith("Mac")
          ? { metaKey: true, altKey: action === "link" }
          : { shiftKey: true, ctrlKey: action === "link" };
        if (action === "failure") {
          Zotero.Attachments.importFromFile = async () => {
            throw new Error("simulated import failure");
          };
        }
        drag(win, grid, "dragover", transfer, modifiers);
        completed = undefined;
        drag(win, grid, "drop", transfer, modifiers);
        assert.isDefined(completed);
        if (action === "failure") {
          try {
            await completed;
            assert.fail("Failed import should reject");
          } catch (error) {
            assert.match(String(error), /simulated import failure/);
          }
          assert.isTrue(await IOUtils.exists(path));
        } else {
          await completed;
          const item = imported.at(-1)!;
          assert.isDefined(item);
          assert.isNotOk(item.parentItemID);
          assert.equal(item.libraryID, Zotero.Libraries.userLibraryID);
          assert.isEmpty(
            item.getCollections(),
            "root import has no collection",
          );
          assert.equal(
            item.attachmentLinkMode,
            action === "link"
              ? Zotero.Attachments.LINK_MODE_LINKED_FILE
              : Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          );
          assert.equal(await IOUtils.exists(path), action === "link");
        }
      }
      assert.lengthOf(imported, 2);
    } finally {
      view.onDrop = originalDrop;
      Zotero.Attachments.importFromFile = originalImport;
      recognize.autoRecognizeItems = originalRecognize;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      for (const item of imported) await item.eraseTx();
      for (const path of paths)
        await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });
});
