import { assert } from "chai";
import { GridRenderer } from "../src/modules/gridRenderer";
import { createRendererHost } from "./helpers/rendererHost";

describe("grid on-demand tiles", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  const items = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: index % 2 ? "A creator" : "",
          getDisplayTitle: () => `Virtual item ${index}`,
          getField: () => (index % 2 ? "2026" : ""),
        }) as Zotero.Item,
    );

  it("updates mounted row positions when column styles change without resizing the host", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      await Zotero.Promise.delay(50);
      const first = host.querySelector<HTMLElement>('[data-item-id="-1"]')!;
      const third = host.querySelector<HTMLElement>('[data-item-id="-3"]')!;
      assert.equal(first.offsetTop, third.offsetTop);
      host.style.gridTemplateColumns = "repeat(2,150px)";
      await Zotero.Promise.delay(50);
      assert.isAbove(third.offsetTop, first.offsetTop);
    } finally {
      renderer.destroy();
    }
  });

  it("matches a fully populated native CSS grid for every caption configuration, padding, gaps and incomplete rows", function () {
    const host = createRendererHost();
    host.style.cssText +=
      ";grid-template-columns:repeat(3,150px);height:200px;padding:19px 23px;gap:31px 17px;justify-content:center;--cover-view-tile-size:150px";
    const renderer = new GridRenderer(host, () => {});
    const collection = items(13);
    const reference = createRendererHost();
    try {
      for (const showTitles of [false, true]) {
        for (const showCreators of [false, true]) {
          for (const showYears of [false, true]) {
            renderer.setItems(collection, {
              showTitles,
              showCreators,
              showYears,
            });
            for (const item of collection) renderer.setFocusedItem(item.id);
            reference.style.cssText = host.style.cssText;
            reference.style.gridTemplateRows = "none";
            reference.replaceChildren(
              ...Array.from(
                host.querySelectorAll(".grid-view-item"),
                (child) => {
                  const tile = child.cloneNode(true) as HTMLElement;
                  tile.style.cssText = "";
                  tile.removeAttribute("id");
                  return tile;
                },
              ),
            );
            assert.equal(
              host.scrollHeight,
              reference.scrollHeight,
              `titles ${showTitles}, creators ${showCreators}, years ${showYears}`,
            );
            const actual = host.querySelector<HTMLElement>(
              '[data-item-id="-13"]',
            )!;
            const expected = reference.querySelector<HTMLElement>(
              '[data-item-id="-13"]',
            )!;
            assert.closeTo(
              actual.getBoundingClientRect().top -
                host.getBoundingClientRect().top,
              expected.getBoundingClientRect().top -
                reference.getBoundingClientRect().top,
              0.02,
            );
            assert.closeTo(
              actual.getBoundingClientRect().left -
                host.getBoundingClientRect().left,
              expected.getBoundingClientRect().left -
                reference.getBoundingClientRect().left,
              0.02,
            );
          }
        }
      }
    } finally {
      renderer.destroy();
    }
  });

  it("reveals offscreen focus and menu anchors without changing independent selection or mounting preceding rows", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(3001), { showCreators: true });
      renderer.setSelection([-2, -1500]);
      renderer.setFocusedItem(-3001, true);
      const focused = host.querySelector<HTMLElement>(
        '[data-item-id="-3001"]',
      )!;
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.equal(focused.getAttribute("aria-selected"), "false");
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 40);
      assert.notExists(host.querySelector('[data-item-id="-1000"]'));
      const anchor = renderer.ensureVisibleMenuAnchor([-1500]);
      assert.equal(anchor?.dataset.itemId, "-1500");
      assert.equal(anchor?.getAttribute("aria-selected"), "true");
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.notExists(host.querySelector('[data-item-id="-1000"]'));
      renderer.setFocusedItem(undefined);
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
    } finally {
      renderer.destroy();
    }
  });

  it("recomputes geometry and clamps scroll after resizing, caption changes, sorting and filtering", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const collection = items(301);
    try {
      host.style.gridTemplateColumns = "repeat(3,150px)";
      renderer.setItems(collection, { showCreators: true });
      renderer.setFocusedItem(-301, true);
      const height = host.scrollHeight;
      host.style.gridTemplateColumns = "repeat(2,150px)";
      renderer.refreshLayout();
      assert.isAbove(host.scrollHeight, height);
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      const captionHeight = host.scrollHeight;
      renderer.setItems(collection, {
        showCreators: false,
        showTitles: false,
        showYears: false,
      });
      assert.isBelow(host.scrollHeight, captionHeight);
      host.style.setProperty("--cover-view-tile-size", "100px");
      renderer.refreshLayout();
      assert.isBelow(host.scrollHeight, captionHeight);
      renderer.setItems(collection.slice(0, 3).reverse(), {
        showCreators: false,
      });
      assert.equal(host.scrollTop, 0);
      assert.deepEqual(
        Array.from(
          host.querySelectorAll<HTMLElement>(".grid-view-item"),
          (entry) => entry.dataset.itemId,
        ),
        ["-3", "-2", "-1"],
      );
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
      renderer.setItems([], { showCreators: false });
      assert.notExists(host.querySelector(".grid-view-item"));
      assert.equal(host.scrollHeight, host.clientHeight);
    } finally {
      renderer.destroy();
    }
  });

  it("defers hidden layouts and restores the required window on becoming visible", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      renderer.setFocusedItem(-301, true);
      const height =
        host.querySelector<HTMLElement>(".grid-view-spacer")!.style.height;
      host.style.display = "none";
      host.style.gridTemplateColumns = "repeat(2,150px)";
      renderer.refreshLayout();
      assert.equal(
        host.querySelector<HTMLElement>(".grid-view-spacer")!.style.height,
        height,
      );
      renderer.setItems(items(133), { showCreators: false });
      renderer.setFocusedItem(-133);
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
      host.style.display = "grid";
      renderer.refreshLayout();
      renderer.setFocusedItem(-133, true);
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      const focused = host.querySelector<HTMLElement>('[data-item-id="-133"]')!;
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.isAbove(host.scrollHeight, host.clientHeight);
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 30);
    } finally {
      renderer.destroy();
    }
  });

  it("represents the full collection immediately and jumps to the end without intervening tiles", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    host.style.cssText =
      "display:grid;grid-template-columns:repeat(3,150px);gap:24px 20px;padding:19px 23px;width:500px;height:200px;overflow:auto;align-content:start;--cover-view-tile-size:150px";
    win.document.documentElement.append(host);
    const renderer = new GridRenderer(host, () => {});
    const items = Array.from(
      { length: 60001 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Virtual item ${index}`,
        }) as Zotero.Item,
    );
    try {
      renderer.setItems(items, { showCreators: false, showYears: false });
      assert.isAbove(
        host.scrollHeight,
        4000000,
        "All 20001 rows contribute height",
      );
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 20);
      const height = host.scrollHeight;
      host.scrollTop = height;
      host.dispatchEvent(new win.Event("scroll"));
      await Zotero.Promise.delay(50);
      const last = host.querySelector<HTMLElement>('[data-item-id="-60001"]');
      assert.exists(last);
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 40);
      assert.notExists(host.querySelector('[data-item-id="-1500"]'));
      assert.equal(host.scrollHeight, height);
      assert.equal(last!.getAttribute("aria-posinset"), "60001");
      assert.equal(last!.getAttribute("aria-setsize"), "60001");
    } finally {
      renderer.destroy();
      host.remove();
    }
  });
});
