import { assert } from "chai";
import { ItemTreeBridge } from "../src/modules/itemTreeBridge";

describe("grid file drops", function () {
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

  it("attaches a direct tile drop without recognition, but imports a gap drop as standalone", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-child-${Zotero.Utilities.randomString()}.pdf`,
    );
    const recognize =
      Zotero.RecognizeDocument as typeof Zotero.RecognizeDocument & {
        autoRecognizeItems: (items: Zotero.Item[]) => void;
      };
    const originalRecognize = recognize.autoRecognizeItems;
    let recognitionCalls = 0;
    let standalone: Zotero.Item | undefined;
    const view = pane.itemsView as typeof pane.itemsView & {
      onDrop: (event: DragEvent, row: number) => Promise<void>;
    };
    const originalDrop = view.onDrop;
    try {
      await IOUtils.write(path, new TextEncoder().encode("%PDF-1.4\n"));
      collection.name = `Tile attachment ${Date.now()}`;
      await collection.saveTx();
      parent.setField("title", "File drop parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      const tile = grid.querySelector<HTMLElement>(
        `[data-item-id="${parent.id}"]`,
      )!;
      assert.isOk(tile);
      recognize.autoRecognizeItems = (items) => {
        recognitionCalls++;
        standalone = items[0];
      };
      const transfer = fileTransfer(path);
      assert.isTrue(
        drag(win, tile.querySelector("figcaption")!, "dragover", transfer)
          .defaultPrevented,
      );
      assert.isTrue(drag(win, tile, "drop", transfer).defaultPrevented);
      for (let i = 0; i < 100 && !parent.getAttachments().length; i++) {
        await Zotero.Promise.delay(50);
      }
      assert.lengthOf(parent.getAttachments(), 1);
      const child = Zotero.Items.get(parent.getAttachments()[0]);
      assert.equal(child.parentItemID, parent.id);
      assert.equal(child.libraryID, parent.libraryID);
      assert.equal(
        child.attachmentLinkMode,
        Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
      );
      assert.isEmpty(child.getCollections());
      assert.equal(recognitionCalls, 0);
      assert.isTrue(await IOUtils.exists(path));

      // A grid gap hits the host itself, not the nearest tile.
      let completed: Promise<void> | undefined;
      view.onDrop = (event, row) => {
        completed = originalDrop.call(view, event, row);
        return completed;
      };
      drag(win, grid, "dragover", transfer);
      drag(win, grid, "drop", transfer);
      assert.isDefined(completed);
      await completed;
      assert.equal(recognitionCalls, 1);
      assert.isDefined(standalone);
      assert.isNotOk(standalone!.parentItemID);
      assert.isTrue(collection.hasItem(standalone!.id));
      assert.lengthOf(parent.getAttachments(), 1);
    } finally {
      view.onDrop = originalDrop;
      recognize.autoRecognizeItems = originalRecognize;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (standalone?.id) await standalone.eraseTx();
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("uses native drag-hover colors regardless of selection, and clears them on leaving or dropping", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const note = new Zotero.Item("note");
    const probe = win.document.createElement("div");
    probe.className = "virtualized-table";
    probe.innerHTML = '<div class="row drop">Native drop color</div>';
    try {
      collection.name = `Hover ${Date.now()}`;
      await collection.saveTx();
      parent.setField("title", "Hover parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      note.setNote("Hover source");
      note.addToCollection(collection.id);
      await note.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      win.document.documentElement.append(probe);
      const nativeStyle = win.getComputedStyle(probe.firstElementChild!);
      const transfer = {
        types: ["zotero/item", "application/x-moz-file"],
        getData: (type: string) =>
          type === "zotero/item" ? String(note.id) : "",
        dropEffect: "move",
      } as unknown as DataTransfer;
      for (const selected of [false, true]) {
        if (selected) await pane.selectItems([parent.id]);
        else pane.itemsView.selection.clearSelection();
        await Zotero.Promise.delay(250);
        const tile = grid.querySelector<HTMLElement>(
          `[data-item-id="${parent.id}"]`,
        )!;
        grid.focus();
        const baseline = win.getComputedStyle(tile).backgroundColor;
        drag(win, tile.querySelector("figcaption")!, "dragover", transfer);
        assert.equal(
          win.getComputedStyle(tile).backgroundColor,
          nativeStyle.backgroundColor,
        );
        assert.equal(win.getComputedStyle(tile).color, nativeStyle.color);
        assert.notEqual(win.getComputedStyle(tile).backgroundColor, baseline);
        const leave = new win.Event("dragleave", { bubbles: true });
        Object.defineProperty(leave, "relatedTarget", {
          value: tile.querySelector("figcaption"),
        });
        tile.dispatchEvent(leave);
        assert.equal(
          win.getComputedStyle(tile).backgroundColor,
          nativeStyle.backgroundColor,
          "moving within a tile keeps its hover color",
        );
        drag(win, grid, "dragover", transfer);
        assert.equal(win.getComputedStyle(tile).backgroundColor, baseline);
        drag(win, tile, "dragover", transfer);
        drag(win, tile, "drop", transfer);
        assert.equal(win.getComputedStyle(tile).backgroundColor, baseline);
        assert.isNotOk(
          note.parentItemID,
          "internal drop implementation belongs to the next ticket",
        );
        drag(win, tile, "dragover", transfer);
        tile.dispatchEvent(new win.Event("dragleave", { bubbles: true }));
        assert.equal(win.getComputedStyle(tile).backgroundColor, baseline);
      }
    } finally {
      probe.remove();
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (note.id) await note.eraseTx();
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("honors move/link modifiers on tiles and preserves a source after a failed child import", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const paths: string[] = [];
    const originalImport = Zotero.Attachments.importFromFile;
    let importAttempt: Promise<Zotero.Item> | undefined;
    try {
      collection.name = `Child modifiers ${Date.now()}`;
      await collection.saveTx();
      parent.setField("title", "Modifier parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      for (const action of ["move", "link", "failure"] as const) {
        const path = PathUtils.join(
          Zotero.DataDirectory.dir,
          `cover-view-child-${action}-${Zotero.Utilities.randomString()}.txt`,
        );
        paths.push(path);
        await IOUtils.write(path, new TextEncoder().encode(action));
        const beforeIDs = parent.getAttachments();
        const before = beforeIDs.length;
        const tile = grid.querySelector<HTMLElement>(
          `[data-item-id="${parent.id}"]`,
        )!;
        const modifiers = win.navigator.platform.startsWith("Mac")
          ? { metaKey: true, altKey: action === "link" }
          : { shiftKey: true, ctrlKey: action === "link" };
        if (action === "failure") {
          Zotero.Attachments.importFromFile = (options) => {
            importAttempt = Promise.reject(new Error("child import failure"));
            return importAttempt;
          };
        }
        const transfer = fileTransfer(path);
        assert.isTrue(
          drag(win, tile, "dragover", transfer, modifiers).defaultPrevented,
        );
        drag(win, tile, "drop", transfer, modifiers);
        if (action === "failure") {
          assert.isDefined(importAttempt);
          await importAttempt!.catch(() => {});
          await Zotero.Promise.delay(100);
          assert.lengthOf(parent.getAttachments(), before);
          assert.isTrue(await IOUtils.exists(path));
        } else {
          for (
            let i = 0;
            i < 100 && parent.getAttachments().length === before;
            i++
          )
            await Zotero.Promise.delay(50);
          assert.lengthOf(parent.getAttachments(), before + 1);
          const child = Zotero.Items.get(
            parent.getAttachments().find((id) => !beforeIDs.includes(id))!,
          );
          assert.equal(child.parentItemID, parent.id);
          assert.equal(
            child.attachmentLinkMode,
            action === "link"
              ? Zotero.Attachments.LINK_MODE_LINKED_FILE
              : Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
          );
          for (
            let i = 0;
            i < 100 && action === "move" && (await IOUtils.exists(path));
            i++
          )
            await Zotero.Promise.delay(50);
          assert.equal(await IOUtils.exists(path), action === "link");
        }
      }
    } finally {
      Zotero.Attachments.importFromFile = originalImport;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
      for (const path of paths)
        await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("rejects non-regular tiles, internal file flavors, restricted contexts, and libraries without file permission", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const note = new Zotero.Item("note");
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-invalid-child-${Zotero.Utilities.randomString()}.txt`,
    );
    let attachment: Zotero.Item | undefined;
    const originalImport = Zotero.Attachments.importFromFile;
    const originalLink = Zotero.Attachments.linkFromFile;
    const view = pane.itemsView;
    const rowsDescriptor = Object.getOwnPropertyDescriptor(
      view,
      "collectionTreeRows",
    );
    const library = Zotero.Libraries.get(Zotero.Libraries.userLibraryID)!;
    const filesDescriptor = Object.getOwnPropertyDescriptor(
      library,
      "filesEditable",
    );
    const editableDescriptor = Object.getOwnPropertyDescriptor(
      library,
      "editable",
    );
    let calls = 0;
    try {
      await IOUtils.write(
        path,
        new TextEncoder().encode("invalid destinations"),
      );
      collection.name = `Rejected tiles ${Date.now()}`;
      await collection.saveTx();
      parent.setField("title", "Invalid drop parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      note.setNote("Cannot attach to a note");
      note.addToCollection(collection.id);
      await note.saveTx();
      attachment = await originalImport.call(Zotero.Attachments, {
        file: path,
        collections: [collection.id],
      });
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(300);
      Zotero.Attachments.importFromFile = async () => {
        calls++;
        throw new Error("Unexpected import");
      };
      Zotero.Attachments.linkFromFile = async () => {
        calls++;
        throw new Error("Unexpected link");
      };
      const valid = fileTransfer(path);
      const tileFor = (id: number) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
      for (const tile of [tileFor(note.id), tileFor(attachment.id)]) {
        assert.isFalse(drag(win, tile, "dragover", valid).defaultPrevented);
        drag(win, tile, "drop", valid);
      }
      const tile = tileFor(parent.id);
      for (const transfer of [
        Object.assign({}, valid, {
          types: ["zotero/item", "application/x-moz-file"],
          getData: () => String(attachment.id),
        }),
        fileTransfer(Zotero.DataDirectory.dir),
        {} as DataTransfer,
      ])
        drag(win, tile, "drop", transfer);
      Object.defineProperty(view, "collectionTreeRows", {
        configurable: true,
        value: [
          {
            ref: { libraryID: parent.libraryID },
            isCollection: () => false,
            isLibrary: () => false,
          },
        ],
      });
      assert.isFalse(drag(win, tile, "dragover", valid).defaultPrevented);
      drag(win, tile, "drop", valid);
      if (rowsDescriptor)
        Object.defineProperty(view, "collectionTreeRows", rowsDescriptor);
      else delete (view as { collectionTreeRows?: unknown }).collectionTreeRows;
      for (const property of ["editable", "filesEditable"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(library, property);
        Object.defineProperty(library, property, {
          configurable: true,
          value: false,
        });
        assert.isFalse(
          drag(win, tile, "dragover", valid).defaultPrevented,
          property,
        );
        drag(win, tile, "drop", valid);
        if (descriptor) Object.defineProperty(library, property, descriptor);
        else delete (library as unknown as Record<string, unknown>)[property];
      }
      assert.equal(calls, 0);
      assert.isEmpty(parent.getAttachments());
      assert.isTrue(await IOUtils.exists(path));
    } finally {
      Zotero.Attachments.importFromFile = originalImport;
      Zotero.Attachments.linkFromFile = originalLink;
      for (const [property, descriptor] of [
        ["editable", editableDescriptor],
        ["filesEditable", filesDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(library, property, descriptor);
        else delete (library as unknown as Record<string, unknown>)[property];
      }
      if (rowsDescriptor)
        Object.defineProperty(view, "collectionTreeRows", rowsDescriptor);
      else delete (view as { collectionTreeRows?: unknown }).collectionTreeRows;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (attachment?.id) await attachment.eraseTx();
      if (note.id) await note.eraseTx();
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("accepts a file drag whose contents are hidden until drop, but validates before import", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const view = pane.itemsView as typeof pane.itemsView & {
      onDrop: (event: DragEvent, row: number) => Promise<void>;
    };
    const originalDrop = view.onDrop;
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-protected-${Zotero.Utilities.randomString()}.pdf`,
    );
    let available = false;
    let calls = 0;
    try {
      await IOUtils.write(path, new TextEncoder().encode("%PDF-1.4\n"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      const transfer = Object.assign(fileTransfer(path), {
        types: ["application/x-moz-file", "text/x-moz-url", "Files"],
        mozGetDataAt: (type: string) => {
          if (!available) throw new Error("file inaccessible during dragover");
          return type === "application/x-moz-file"
            ? fileTransfer(path).mozGetDataAt(type, 0)
            : null;
        },
      });
      view.onDrop = async (_event, row) => {
        assert.equal(row, -1);
        calls++;
      };
      assert.isTrue(
        drag(win, grid, "dragover", transfer).defaultPrevented,
        "the grid must opt in to the drop before file objects are exposed",
      );
      available = true;
      assert.isTrue(drag(win, grid, "drop", transfer).defaultPrevented);
      assert.equal(calls, 1, "verified local file reaches native importer");

      available = false;
      drag(win, grid, "dragover", transfer);
      available = true;
      const directory = Object.assign({}, transfer, {
        mozGetDataAt: () =>
          fileTransfer(Zotero.DataDirectory.dir).mozGetDataAt(
            "application/x-moz-file",
            0,
          ),
      }) as DataTransfer;
      drag(win, grid, "drop", directory);
      assert.equal(calls, 1, "a directory must not reach native importer");
    } finally {
      view.onDrop = originalDrop;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

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
    let importedWrapped: Zotero.Item | undefined;
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

      // External Gecko drags can expose an nsISupports wrapper with no path
      // until the native file interface is requested.
      const wrapped = {
        QueryInterface: (_iface: typeof Ci.nsIFile) => {
          Object.assign(wrapped, {
            path: file.path,
            isFile: () => true,
            isDirectory: () => false,
          });
          return file;
        },
      };
      const wrappedTransfer = {
        types: ["application/x-moz-file", "text/x-moz-url", "Files"],
        mozItemCount: 1,
        mozGetDataAt: () => wrapped,
        getData: () => "",
        dropEffect: "copy",
      } as unknown as DataTransfer;
      assert.isTrue(bridge.canDropFiles(wrappedTransfer));
      completed = undefined;
      drag(win, grid, "dragover", wrappedTransfer);
      drag(win, grid, "drop", wrappedTransfer);
      assert.isDefined(completed);
      await completed;
      importedWrapped = recognized[0];
      assert.isTrue(importedWrapped.isPDFAttachment());
      assert.isTrue(collection.hasItem(importedWrapped.id));
      assert.notEqual(importedWrapped.id, imported.id);
    } finally {
      nativeItemsView.onDrop = originalOnDrop;
      recognize.autoRecognizeItems = originalRecognize;
      bridge.destroy();
      if (grid.hidden !== originalHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      if (imported?.id) await imported.eraseTx();
      if (importedWrapped?.id) await importedWrapped.eraseTx();
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
