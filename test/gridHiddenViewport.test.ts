import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
import { GridRenderer } from "../src/modules/gridRenderer";
import { createRendererHost } from "./helpers/rendererHost";

describe("hidden library viewport", function () {
  this.timeout(30000);

  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  const renderItems = (count: number, start = 1) =>
    Array.from(
      { length: count },
      (_, index) =>
        ({
          id: -(index + start),
          getDisplayTitle: () => `Hidden item ${index}`,
          getField: () => "",
        }) as Zotero.Item,
    );

  it("retains the visible item across zero-sized geometry and delayed combined reflow", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const items = renderItems(90);
    try {
      renderer.setItems(items, {});
      const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop = tile.offsetTop + 37;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const offset =
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(4,180px)";
      });
      assert.closeTo(
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
      );
      host.style.display = "none";
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(2,240px)";
        host.style.setProperty("--cover-view-tile-size", "240px");
      });
      assert.equal(host.clientWidth, 0);
      assert.equal(host.clientHeight, 0);
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      await Zotero.Promise.delay(500);
      host.style.display = "grid";
      renderer.refreshLayout();
      const restored = host.querySelector<HTMLElement>('[data-item-id="-7"]');
      assert.exists(restored, "The original viewport item is still mounted");
      assert.closeTo(
        restored!.getBoundingClientRect().top -
          host.getBoundingClientRect().top,
        offset,
        1,
      );
      assert.strictEqual(restored, tile, "Unchanged tiles are retained");
      assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
    } finally {
      renderer.destroy();
    }
  });

  for (const change of ["none", "width", "tile size"]) {
    it(`retains the viewport without drift through repeated hidden ${change} changes`, async function () {
      const host = createRendererHost();
      const renderer = new GridRenderer(host, () => {});
      try {
        renderer.setItems(renderItems(90), {});
        const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
        host.scrollTop = tile.offsetTop + 37;
        host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
        const offset =
          tile.getBoundingClientRect().top - host.getBoundingClientRect().top;
        for (let cycle = 0; cycle < 3; cycle++) {
          host.style.display = "none";
          renderer.refreshLayout(() => {
            if (change === "width")
              host.style.gridTemplateColumns = `repeat(${cycle % 2 ? 3 : 2},180px)`;
            if (change === "tile size")
              host.style.setProperty(
                "--cover-view-tile-size",
                `${cycle % 2 ? 180 : 240}px`,
              );
          });
          await Zotero.Promise.delay(400);
          host.style.display = "grid";
          renderer.refreshLayout();
          assert.closeTo(
            tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
            offset,
            1,
          );
          assert.strictEqual(host.querySelector('[data-item-id="-7"]'), tile);
          assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
        }
      } finally {
        renderer.destroy();
      }
    });
  }

  it("restores a retained anchor when hidden scrolling clamps an otherwise unchanged layout", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(renderItems(90), {});
      const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop = tile.offsetTop + 37;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const offset =
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top;
      host.style.display = "none";
      renderer.refreshLayout();
      // Simulate a scroll frame losing its offset while it has no geometry.
      host.scrollTop = 0;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      renderer.refreshLayout();
      host.style.display = "grid";
      // Gecko can defer scroll changes until the frame becomes measurable.
      host.scrollTop = 0;
      assert.equal(host.scrollTop, 0);
      renderer.refreshLayout();
      assert.closeTo(
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
      );
    } finally {
      renderer.destroy();
    }
  });

  for (const change of ["missing item", "new context", "empty grid"]) {
    it(`does not resurrect stale item state after a hidden ${change}`, function () {
      const host = createRendererHost();
      const renderer = new GridRenderer(host, () => {});
      try {
        const items = renderItems(90);
        renderer.setItems(items, {});
        renderer.setSelection([-7]);
        renderer.setFocusedItem(-7);
        const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
        host.scrollTop = tile.offsetTop + 37;
        host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
        renderer.refreshLayout(() => {
          host.style.gridTemplateColumns = "repeat(4,180px)";
        });
        host.style.display = "none";
        renderer.refreshLayout();
        const next =
          change === "missing item"
            ? items.filter((item) => item.id !== -7)
            : change === "new context"
              ? renderItems(12, 100)
              : [];
        renderer.setItems(next, {});
        renderer.setSelection([]);
        renderer.setFocusedItem(undefined);
        host.style.gridTemplateColumns = "repeat(2,180px)";
        host.style.display = "grid";
        renderer.refreshLayout();
        assert.notExists(host.querySelector('[data-item-id="-7"]'));
        assert.notExists(host.querySelector('[aria-selected="true"]'));
        assert.notExists(host.getAttribute("aria-activedescendant"));
        assert.isAtLeast(host.scrollTop, 0);
        assert.isAtMost(
          host.scrollTop,
          Math.max(0, host.scrollHeight - host.clientHeight),
        );
        if (change === "empty grid") {
          assert.notExists(host.querySelector(".grid-view-item"));
          assert.equal(host.scrollTop, 0);
        }
      } finally {
        renderer.destroy();
      }
    });
  }

  for (const boundary of ["beginning", "end"]) {
    it(`clamps hidden reflows safely at the ${boundary}`, function () {
      const host = createRendererHost();
      const renderer = new GridRenderer(host, () => {});
      try {
        renderer.setItems(renderItems(301), {});
        host.scrollTop = boundary === "beginning" ? 0 : host.scrollHeight;
        host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
        host.style.display = "none";
        renderer.refreshLayout(() => {
          host.style.gridTemplateColumns = "repeat(5,180px)";
        });
        host.style.display = "grid";
        renderer.refreshLayout();
        assert.closeTo(
          host.scrollTop,
          boundary === "beginning" ? 0 : host.scrollHeight - host.clientHeight,
          4,
        );
        assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 40);
      } finally {
        renderer.destroy();
      }
    });
  }

  for (const check of [
    "viewport offset without drift",
    "native selection",
    "selection anchor",
    "focused tile",
    "keyboard focus ownership",
    "unchanged covers",
    "bounded mounted tiles",
  ]) {
    it(`preserves ${check} after delayed hidden tile-size and width changes`, async function () {
      const win = Zotero.getMainWindow()!;
      const pane = win.ZoteroPane;
      const grid = win.document.getElementById("cover-view-grid")!;
      const originalStyle = grid.style.cssText;
      const originalSize = getPref("tileSize");
      const originallyHidden = grid.hidden;
      const collection = new Zotero.Collection();
      const items: Zotero.Item[] = [];
      let tabID: string | undefined;
      const toggle = () =>
        win.document
          .getElementById("cover-view-toggle")!
          .dispatchEvent(new win.Event("command"));
      const waitFor = async (condition: () => boolean, message: string) => {
        const deadline = Date.now() + 5000;
        while (!condition() && Date.now() < deadline)
          await Zotero.Promise.delay(20);
        assert.isTrue(condition(), message);
      };
      const tile = (index: number) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${items[index].id}"]`);
      const offset = () =>
        tile(6)!.getBoundingClientRect().top - grid.getBoundingClientRect().top;
      try {
        collection.name = "Hidden viewport";
        await collection.saveTx();
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 0; index < 90; index++) {
            const item = new Zotero.Item("book");
            item.setField(
              "title",
              `Hidden viewport ${String(index).padStart(3, "0")}`,
            );
            item.addToCollection(collection.id);
            await item.save();
            items.push(item);
          }
        });
        await pane.collectionsView!.selectByID(`C${collection.id}`);
        if (grid.hidden) toggle();
        grid.style.cssText +=
          ";flex:none;box-sizing:border-box;width:630px;height:300px;padding:19px;gap:20px;grid-template-columns:repeat(auto-fill,minmax(var(--cover-view-tile-size),1fr))";
        setPref("tileSize", 180);
        await waitFor(() => !!tile(6), "Initial grid renders");
        tile(1)!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
        await waitFor(
          () => pane.getSelectedItems(true)[0] === items[1].id,
          "Selection settles",
        );
        grid.scrollTop = tile(6)!.offsetTop + 37;
        grid.dispatchEvent(new win.Event("scroll"));
        const originalOffset = offset();
        const focused = grid.getAttribute("aria-activedescendant");
        await waitFor(
          () => !!tile(6)!.querySelector("img")?.getAttribute("src"),
          "Viewport cover loads",
        );
        const cover = tile(6)!.querySelector("img");
        const coverURI = cover!.getAttribute("src");
        tabID = win.Zotero_Tabs.add({
          type: "reader",
          title: "Hidden viewport",
          data: { itemID: items[1].id },
          select: true,
        }).id;
        await waitFor(
          () => win.Zotero_Tabs.selectedType === "reader",
          "Reader tab opens",
        );
        grid.style.width = "520px";
        setPref("tileSize", 240);
        await Zotero.Promise.delay(500);
        win.Zotero_Tabs.select("zotero-pane");
        await waitFor(
          () => grid.clientWidth > 0 && !!tile(6),
          "Library grid returns",
        );
        await Zotero.Promise.delay(100);
        if (check === "viewport offset without drift") {
          assert.closeTo(
            offset(),
            originalOffset,
            1,
            "The same book retains its viewport offset",
          );
          for (let cycle = 0; cycle < 3; cycle++) {
            win.Zotero_Tabs.select(tabID);
            await Zotero.Promise.delay(400);
            win.Zotero_Tabs.select("zotero-pane");
            await Zotero.Promise.delay(100);
            assert.closeTo(
              offset(),
              originalOffset,
              1,
              "Repeated tab switches do not drift",
            );
          }
        }
        if (check === "native selection")
          assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
        if (check === "focused tile")
          assert.equal(grid.getAttribute("aria-activedescendant"), focused);
        if (check === "keyboard focus ownership") {
          const collectionsTree = win.document.getElementById(
            "zotero-collections-tree",
          )!;
          collectionsTree.querySelector<HTMLElement>("[role=tree]")!.focus();
          const returnFocus = win.document.activeElement;
          grid.style.width = "530px";
          await Zotero.Promise.delay(100);
          assert.strictEqual(
            win.document.activeElement,
            returnFocus,
            "Layout restoration does not move keyboard focus",
          );
        }
        if (check === "unchanged covers") {
          assert.strictEqual(tile(6)!.querySelector("img"), cover);
          assert.equal(cover!.getAttribute("src"), coverURI);
        }
        if (check === "bounded mounted tiles")
          assert.isAtMost(grid.querySelectorAll(".grid-view-item").length, 25);
        if (check === "selection anchor") {
          grid.dispatchEvent(
            new win.KeyboardEvent("keydown", {
              key: "ArrowRight",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          await waitFor(
            () => pane.getSelectedItems(true).length === 2,
            "Shift selection extends",
          );
          assert.sameMembers(
            pane.getSelectedItems(true),
            [items[1].id, items[2].id],
            "Selection anchor remains unchanged",
          );
        }
      } finally {
        win.Zotero_Tabs.select("zotero-pane");
        if (tabID) win.Zotero_Tabs.close(tabID);
        grid.style.cssText = originalStyle;
        setPref("tileSize", originalSize);
        if (grid.hidden !== originallyHidden) toggle();
        await pane.collectionsView!.selectLibrary(
          Zotero.Libraries.userLibraryID,
        );
        for (const item of items) if (item.id) await item.eraseTx();
        if (collection.id) await collection.eraseTx();
      }
    });
  }
});
