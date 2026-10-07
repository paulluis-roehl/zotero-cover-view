import { assert } from "chai";

describe("native item tree restoration", function () {
  this.timeout(30000);

  async function waitFor(condition: () => boolean, message: string) {
    const deadline = Date.now() + 6000;
    while (!condition() && Date.now() < deadline)
      await Zotero.Promise.delay(20);
    assert.isTrue(condition(), message);
  }

  it("restores visible selected rows and focus on list switching and hot window detach/attach", async function () {
    const win = Zotero.getMainWindow()!;
    // The scaffold's test window can occlude this window and suspend its
    // animation-frame-based native layout/focus restoration.
    win.focus();
    const pane = win.ZoteroPane;
    const tree = win.document.getElementById("zotero-items-tree")!;
    const originallyHidden =
      win.document.getElementById("cover-view-grid")!.hidden;
    const collection = new Zotero.Collection();
    const items = Array.from({ length: 90 }, () => new Zotero.Item("book"));
    const hooks = Zotero.CoverView.hooks;
    const grid = () => win.document.getElementById("cover-view-grid")!;
    const toggle = () =>
      win.document
        .getElementById("cover-view-toggle")!
        .dispatchEvent(new win.Event("command"));
    const selectedRowVisible = (item: Zotero.Item) => {
      const row = tree.querySelector<HTMLElement>(".row.selected");
      if (!row?.textContent?.includes(String(item.getField("title"))))
        return false;
      const rect = row.getBoundingClientRect();
      const viewport = tree.getBoundingClientRect();
      return (
        rect.height > 0 &&
        rect.top >= viewport.top - 2 &&
        rect.bottom <= viewport.bottom + 2
      );
    };
    try {
      collection.name = "Native restoration";
      await collection.saveTx();
      for (const [index, item] of items.entries()) {
        item.setField("title", `Restoration ${String(index).padStart(3, "0")}`);
        item.addToCollection(collection.id);
        await item.saveTx();
      }
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid().hidden) toggle();
      for (const item of [items.at(-1)!, items[0], items.at(-1)!]) {
        await pane.selectItems([item.id]);
        grid().focus();
        toggle();
        await waitFor(
          () => selectedRowVisible(item),
          "List mode shows its selected row inside the viewport",
        );
        await waitFor(
          () => tree.contains(win.document.activeElement),
          "List mode owns focus",
        );
        assert.deepEqual(pane.getSelectedItems(true), [item.id]);
        toggle();
      }
      grid().focus();
      hooks.onMainWindowUnload(win);
      assert.isNull(win.document.getElementById("cover-view-grid"));
      assert.notEqual(tree.style.display, "none");
      await waitFor(
        () => selectedRowVisible(items.at(-1)!),
        "Hot detach repairs the native viewport",
      );
      await waitFor(
        () => tree.contains(win.document.activeElement),
        "Hot detach returns grid-owned focus to the native tree",
      );
      hooks.onMainWindowLoad(win);
      await waitFor(
        () => !!grid() && !grid().hidden,
        "Hot attach restores grid mode",
      );
      assert.deepEqual(pane.getSelectedItems(true), [items.at(-1)!.id]);
    } finally {
      if (!win.document.getElementById("cover-view-grid"))
        hooks.onMainWindowLoad(win);
      if (grid().hidden !== originallyHidden) toggle();
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of items) if (item.id) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("restores the current collection after hot reattachment and window reopening without stealing other-pane focus", async function () {
    const first = Zotero.getMainWindow()!;
    const existing = new Set(Zotero.getMainWindows());
    const hooks = Zotero.CoverView.hooks;
    const originallyHidden =
      first.document.getElementById("cover-view-grid")!.hidden;
    const collections = [new Zotero.Collection(), new Zotero.Collection()];
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    let opened: _ZoteroTypes.MainWindow | undefined;
    const open = async () => {
      Zotero.openMainWindow();
      await waitFor(() => {
        opened = Zotero.getMainWindows().find(
          (win) => !existing.has(win) && !win.closed,
        );
        return (
          !!opened?.ZoteroPane?.loaded &&
          !!opened.ZoteroPane.itemsView &&
          !!opened.ZoteroPane.collectionsView
        );
      }, "Reopened native window is ready");
      await opened!.ZoteroPane.collectionsView!.waitForLoad();
      await opened!.ZoteroPane.itemsView!.waitForLoad();
      // Temporary scaffold add-ons do not dispatch new-window hooks.
      hooks.onMainWindowLoad(opened!);
      opened!.focus();
      return opened!;
    };
    try {
      if (originallyHidden)
        first.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new first.Event("command"));
      for (const [index, collection] of collections.entries()) {
        collection.name = `Restored context ${index}`;
        await collection.saveTx();
        items[index].setField("title", `Context item ${index}`);
        items[index].addToCollection(collection.id);
        await items[index].saveTx();
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        const win = await open();
        const pane = win.ZoteroPane;
        for (const collection of collections)
          await pane.collectionsView!.selectByID(`C${collection.id}`);
        await pane.selectItems([items[1].id]);
        const currentGrid = () =>
          win.document.getElementById("cover-view-grid")!;
        await waitFor(
          () =>
            !!currentGrid().querySelector(`[data-item-id="${items[1].id}"]`),
          "Grid follows the new collection",
        );
        const collectionsTree = win.document.getElementById(
          "zotero-collections-tree",
        )!;
        collectionsTree.querySelector<HTMLElement>("[role=tree]")!.focus();
        const otherPaneFocus = win.document.activeElement;
        hooks.onMainWindowUnload(win);
        await new Promise<void>((resolve) =>
          win.requestAnimationFrame(() => resolve()),
        );
        assert.strictEqual(
          win.document.activeElement,
          otherPaneFocus,
          "Teardown does not steal collection-pane focus",
        );
        hooks.onMainWindowLoad(win);
        await waitFor(
          () =>
            !!currentGrid().querySelector(`[data-item-id="${items[1].id}"]`),
          "Hot reattachment uses the current collection",
        );
        assert.isNull(
          currentGrid().querySelector(`[data-item-id="${items[0].id}"]`),
        );
        assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
        win.focus();
        currentGrid().focus();
        await waitFor(
          () => win.document.activeElement === currentGrid(),
          "Reattached grid owns focus before switching modes",
        );
        win.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new win.Event("command"));
        const tree = win.document.getElementById("zotero-items-tree")!;
        await waitFor(
          () =>
            !!tree
              .querySelector(".row.selected")
              ?.textContent?.includes("Context item 1"),
          "Reopened window returns to the correct native rows",
        );
        await waitFor(
          () => tree.contains(win.document.activeElement),
          "Reopened window returns focus to the native tree",
        );
        // Restore the shared grid preference before creating the next window.
        win.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new win.Event("command"));
        hooks.onMainWindowUnload(win);
        win.close();
        opened = undefined;
      }
    } finally {
      if (opened && !opened.closed) {
        hooks.onMainWindowUnload(opened);
        opened.close();
      }
      const grid = first.document.getElementById("cover-view-grid")!;
      if (grid.hidden !== originallyHidden)
        first.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new first.Event("command"));
      await first.ZoteroPane.collectionsView!.selectLibrary(
        Zotero.Libraries.userLibraryID,
      );
      for (const item of items) if (item.id) await item.eraseTx();
      for (const collection of collections)
        if (collection.id) await collection.eraseTx();
    }
  });

  it("restores the native item tree through hot plugin shutdown/startup", async function () {
    const win = Zotero.getMainWindow()!;
    win.focus();
    const pane = win.ZoteroPane;
    const plugin = Zotero.CoverView;
    const originallyHidden =
      win.document.getElementById("cover-view-grid")!.hidden;
    const item = new Zotero.Item("book");
    let shutdown = false;
    const restart = async () => {
      // The scaffold directly loads the temporary plugin sandbox. Recreate
      // its bootstrap registration before invoking the actual startup hook.
      Zotero.CoverView = plugin;
      plugin.data.alive = true;
      await plugin.hooks.onStartup();
      shutdown = false;
    };
    try {
      item.setField("title", "Hot plugin restoration");
      await item.saveTx();
      await pane.selectItems([item.id]);
      let grid = win.document.getElementById("cover-view-grid")!;
      if (grid.hidden)
        win.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new win.Event("command"));
      grid.focus();
      shutdown = true;
      plugin.hooks.onShutdown();
      const tree = win.document.getElementById("zotero-items-tree")!;
      await waitFor(
        () =>
          !win.document.getElementById("cover-view-grid") &&
          !!tree
            .querySelector(".row.selected")
            ?.textContent?.includes("Hot plugin restoration") &&
          tree.contains(win.document.activeElement),
        "Disabling the plugin restores native rows and focus",
      );
      assert.deepEqual(pane.getSelectedItems(true), [item.id]);
      await restart();
      grid = win.document.getElementById("cover-view-grid")!;
      await waitFor(
        () => !!grid.querySelector(`[data-item-id="${item.id}"]`),
        "Re-enabling the plugin renders the current native items",
      );
      assert.deepEqual(pane.getSelectedItems(true), [item.id]);
    } finally {
      if (shutdown) await restart();
      const grid = win.document.getElementById("cover-view-grid")!;
      if (grid.hidden !== originallyHidden)
        win.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new win.Event("command"));
      if (item.id) await item.eraseTx();
    }
  });
});
