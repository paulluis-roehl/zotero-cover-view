import { assert } from "chai";
import { ItemTreeBridge } from "../src/modules/itemTreeBridge";

describe("grid native item drag", function () {
  it("exports standalone attachment files but not a parent tile's child files", async function () {
    const win = Zotero.getMainWindow()!;
    const bridge = new ItemTreeBridge(win);
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      `cover-view-drag-${Zotero.Utilities.randomString()}.pdf`,
    );
    const parent = new Zotero.Item("book");
    let attachment: Zotero.Item | undefined;
    let child: Zotero.Item | undefined;
    const dragDrop = (
      Zotero as typeof Zotero & {
        DragDrop: { currentDragSource: unknown };
      }
    ).DragDrop;
    const originalSource = dragDrop.currentDragSource;
    try {
      await IOUtils.write(path, new TextEncoder().encode("file drag fixture"));
      parent.setField("title", "Parent without exported child files");
      await parent.saveTx();
      attachment = await Zotero.Attachments.linkFromFile({ file: path });
      child = await Zotero.Attachments.linkFromFile({
        file: path,
        parentItemID: parent.id,
      });
      assert.equal(child.parentItemID, parent.id);
      const entries: Array<{ type: string; value: unknown }> = [];
      const data = new Map<string, string>();
      const transfer = {
        effectAllowed: "uninitialized",
        setDragImage: () => {},
        setData: (type: string, value: string) => data.set(type, String(value)),
        mozSetDataAt: (type: string, value: unknown) =>
          entries.push({ type, value }),
      };
      const tile = win.document.createElement("figure");
      tile.className = "grid-view-item";
      win.document.documentElement.append(tile);
      try {
        for (const item of [parent, attachment]) {
          const event = new win.Event("dragstart", {
            bubbles: true,
          }) as DragEvent;
          Object.defineProperty(event, "dataTransfer", { value: transfer });
          tile.addEventListener(
            "dragstart",
            () => bridge.startItemDrag(event, [item.id]),
            { once: true },
          );
          tile.dispatchEvent(event);
          assert.equal(data.get("zotero/item"), String(item.id));
          assert.equal(
            entries.filter((entry) => entry.type === "application/x-moz-file")
              .length,
            item === attachment ? 1 : 0,
          );
          entries.length = 0;
        }
      } finally {
        tile.remove();
      }
    } finally {
      dragDrop.currentDragSource = originalSource;
      bridge.destroy();
      if (attachment?.id) await attachment.eraseTx();
      if (child?.id) await child.eraseTx();
      if (parent.id) await parent.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("drags mounted and unmounted selected items in native order without changing selection", async function () {
    this.timeout(120000);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const toggle = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const destination = new Zotero.Collection();
    const items: Zotero.Item[] = [];
    const internal = Zotero.Utilities.Internal as unknown as {
      onDragItems: (event: DragEvent, ids: number[], image: Element) => void;
    };
    const nativeHelper = internal.onDragItems;
    const dragDrop = (
      Zotero as typeof Zotero & {
        DragDrop: {
          currentDragSource: unknown;
          currentOrientation: number;
          currentDropEffect: string | null;
        };
      }
    ).DragDrop;
    const originalSource = dragDrop.currentDragSource;
    const originalOrientation = dragDrop.currentOrientation;
    const originalEffect = dragDrop.currentDropEffect;
    const quickCopy = Zotero.QuickCopy as {
      getFormatFromURL: (url: string) => string;
      unserializeSetting: (setting: string) => unknown;
      getContentFromItems: (...args: unknown[]) => unknown;
    };
    const originalFormat = quickCopy.getFormatFromURL;
    const originalUnserialize = quickCopy.unserializeSetting;
    const originalContent = quickCopy.getContentFromItems;
    const calls: Array<{ ids: number[]; source: unknown; image: Element }> = [];
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition(), "Grid did not update");
    };
    try {
      collection.name = `Grid drag ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      destination.name = `Grid drag destination ${Date.now()}`;
      destination.libraryID = collection.libraryID;
      await destination.saveTx();
      for (let index = 0; index < 121; index++) {
        const item = new Zotero.Item("book");
        item.setField("title", `Grid drag ${String(index).padStart(3, "0")}`);
        item.addToCollection(collection.id);
        await item.saveTx();
        items.push(item);
      }
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) toggle.dispatchEvent(new win.Event("command"));
      await waitFor(
        () => !!grid.querySelector(`[data-item-id="${items[1].id}"]`),
      );
      const tiles = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const ids = items.map((item) => item.id);
      await pane.selectItems([ids[120], ids[60], ids[0]]);
      assert.notExists(grid.querySelector(`[data-item-id="${ids[60]}"]`));
      const source = (
        pane.itemsView as typeof pane.itemsView & {
          collectionTreeRows: unknown[];
        }
      ).collectionTreeRows[0];
      internal.onDragItems = (_event, dragIDs, image) => {
        calls.push({
          ids: [...dragIDs],
          source: dragDrop.currentDragSource,
          image,
        });
      };
      const drag = (tile: HTMLElement) => {
        const event = new win.Event("dragstart", {
          bubbles: true,
          cancelable: true,
        }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: {} });
        tile.querySelector(".grid-view-title")!.dispatchEvent(event);
        assert.isFalse(event.defaultPrevented);
      };
      drag(tiles[0]);
      assert.deepEqual(calls[0].ids, [ids[0], ids[60], ids[120]]);
      assert.strictEqual(calls[0].source, source);
      assert.strictEqual(calls[0].image, tiles[0]);
      drag(tiles[1]);
      assert.deepEqual(calls[1].ids, [ids[1]]);
      assert.deepEqual(
        pane.getSelectedItems(true).sort(),
        [ids[0], ids[60], ids[120]].sort(),
      );
      assert.isTrue(tiles[0].draggable);
      assert.isFalse(tiles[0].querySelector("img")!.draggable);

      // Exercise the installed helper, not a duplicate file/Quick Copy implementation.
      internal.onDragItems = nativeHelper;
      quickCopy.getFormatFromURL = () => "test-bibliography";
      quickCopy.unserializeSetting = () => ({ mode: "bibliography" });
      quickCopy.getContentFromItems = () => ({
        text: "Grid citation",
        html: "<p>Grid citation</p>",
      });
      const data = new Map<string, string>();
      const transfer = {
        effectAllowed: "uninitialized",
        setDragImage: () => {},
        setData: (type: string, value: string) => data.set(type, String(value)),
      };
      const event = new win.Event("dragstart", {
        bubbles: true,
        cancelable: true,
      }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      tiles[0].dispatchEvent(event);
      assert.equal(data.get("zotero/item"), `${ids[0]},${ids[60]},${ids[120]}`);
      assert.isTrue(
        data.has("text/plain"),
        "Native Quick Copy text is exposed",
      );
      assert.equal(data.get("text/html"), "<p>Grid citation</p>");

      // Hand the actual payload to Zotero's collection drop handler. The grid
      // does not emulate the collection tree's add/move/copy rules.
      const collectionTree =
        pane.collectionsView! as typeof pane.collectionsView & {
          canDropCheck: (
            row: number,
            orientation: number,
            transfer: unknown,
          ) => boolean;
          onDrop: (event: unknown, row: number) => Promise<void>;
        };
      const transferForDrop = {
        types: [...data.keys()],
        getData: (type: string) => data.get(type) ?? "",
        dropEffect: "copy",
        effectAllowed: "copyMove",
      };
      const sourceIndex = collectionTree.getRowIndexByID(`C${collection.id}`);
      const targetIndex = collectionTree.getRowIndexByID(`C${destination.id}`);
      assert.isNumber(sourceIndex);
      assert.isNumber(targetIndex);
      assert.isFalse(
        collectionTree.canDropCheck(sourceIndex as number, 0, transferForDrop),
      );
      assert.isTrue(
        collectionTree.canDropCheck(targetIndex as number, 0, transferForDrop),
      );
      dragDrop.currentOrientation = 0;
      dragDrop.currentDropEffect = "copy";
      await collectionTree.onDrop(
        { dataTransfer: transferForDrop },
        targetIndex as number,
      );
      assert.isTrue(destination.hasItem(ids[0]));
      assert.isTrue(destination.hasItem(ids[60]));
      assert.isTrue(destination.hasItem(ids[120]));
      assert.isTrue(
        collection.hasItem(ids[0]),
        "Copy keeps source collection membership",
      );
    } finally {
      internal.onDragItems = nativeHelper;
      quickCopy.getFormatFromURL = originalFormat;
      quickCopy.unserializeSetting = originalUnserialize;
      quickCopy.getContentFromItems = originalContent;
      dragDrop.currentDragSource = originalSource;
      dragDrop.currentOrientation = originalOrientation;
      dragDrop.currentDropEffect = originalEffect;
      if (grid.hidden !== originallyHidden)
        toggle.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of items) await item.eraseTx();
      if (destination.id) await destination.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });
});
