import { assert } from "chai";
import { GridRenderer } from "../src/modules/gridRenderer";

describe("grid navigation geometry", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("finds adjacent destinations in native order even when neither tile is mounted", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    host.style.cssText =
      "display:grid;grid-template-columns:repeat(3,150px);gap:24px 20px;width:500px;height:200px;overflow:auto;align-content:start;--cover-view-tile-size:150px";
    win.document.documentElement.append(host);
    const renderer = new GridRenderer(host, () => {});
    const items = Array.from(
      { length: 133 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Geometry item ${index}`,
        }) as Zotero.Item,
    );
    try {
      renderer.setItems(items, { showCreators: false, showYears: false });
      const mounted = host.querySelectorAll(".grid-view-item").length;
      assert.isBelow(mounted, 20);
      assert.equal(renderer.getVerticalDestination(-128, 1), -131);
      assert.equal(renderer.getVerticalDestination(-128, -1), -125);
      assert.equal(renderer.getVerticalDestination(-131, 1), -133);
      assert.isUndefined(renderer.getVerticalDestination(-133, 1));
      host.scrollTop = 0;
      assert.equal(renderer.getPageDestination(-128, 1), -131);
      assert.equal(renderer.getPageDestination(-2, -1), -2);
      assert.equal(renderer.getPageDestination(-133, 1), -133);
      assert.lengthOf(
        host.querySelectorAll(".grid-view-item"),
        mounted,
        "Destination queries do not mount tiles",
      );
      host.style.gridTemplateColumns = "repeat(2,150px)";
      assert.equal(renderer.getVerticalDestination(-128, 1), -130);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), mounted);
    } finally {
      renderer.destroy();
      host.remove();
    }
  });

  it("matches displayed viewport edges across caption settings, gaps, padding and column changes", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    host.id = "cover-view-grid";
    host.style.cssText =
      "display:grid;flex:none;width:600px;height:300px;--cover-view-tile-size:150px;row-gap:31px;column-gap:17px;padding:19px 23px";
    win.document.documentElement.append(host);
    const renderer = new GridRenderer(host, () => {});
    const items = Array.from(
      { length: 13 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: index % 2 ? "A creator" : "",
          getDisplayTitle: () => `Geometry item ${index}`,
          getField: () => (index % 2 ? "2026" : ""),
        }) as Zotero.Item,
    );
    try {
      for (const showTitles of [false, true]) {
        for (const showCreators of [false, true]) {
          for (const showYears of [false, true]) {
            renderer.setItems(items, { showTitles, showCreators, showYears });
            renderer.setFocusedItem(-11);
            const fourthRow = host.querySelector<HTMLElement>(
              '[data-item-id="-11"]',
            )!;
            assert.equal(renderer.getVerticalDestination(-2, 1), -5);
            for (const visiblePixels of [0, 1]) {
              host.scrollTop = 0;
              const fourthRowTop =
                fourthRow.getBoundingClientRect().top -
                host.getBoundingClientRect().top;
              host.style.height = `${fourthRowTop + visiblePixels}px`;
              host.scrollTop = 0;
              assert.equal(
                renderer.getPageDestination(-2, 1),
                visiblePixels ? -11 : -8,
                `Down edge: titles ${showTitles}, creators ${showCreators}, years ${showYears}, visible ${visiblePixels}`,
              );
            }
            host.style.height = "300px";
            host.scrollTop = 0;
            renderer.setFocusedItem(-5);
            const secondRow = host.querySelector<HTMLElement>(
              '[data-item-id="-5"]',
            )!;
            const secondRowBottom =
              secondRow.getBoundingClientRect().bottom -
              host.getBoundingClientRect().top;
            // Gecko's scrollTop is integer-valued. Align the row edge to a
            // whole pixel so zero versus one visible pixel is unambiguous.
            host.style.paddingTop = `${19 + Math.ceil(secondRowBottom) - secondRowBottom}px`;
            renderer.refreshLayout();
            for (const visiblePixels of [0, 1]) {
              host.scrollTop = Math.ceil(secondRowBottom) - visiblePixels;
              assert.closeTo(
                secondRow.getBoundingClientRect().bottom -
                  host.getBoundingClientRect().top,
                visiblePixels,
                0.02,
              );
              assert.equal(
                renderer.getPageDestination(-11, -1),
                visiblePixels ? -5 : -8,
                `Up edge: titles ${showTitles}, creators ${showCreators}, years ${showYears}, visible ${visiblePixels}`,
              );
            }
            host.style.paddingTop = "19px";
          }
        }
      }
      host.style.width = "440px";
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      host.style.width = "600px";
      host.style.setProperty("--cover-view-tile-size", "180px");
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      host.style.setProperty("--cover-view-tile-size", "150px");
      assert.equal(renderer.getVerticalDestination(-2, 1), -5);
      assert.isUndefined(renderer.getPageDestination(999, 1));
    } finally {
      renderer.destroy();
      host.remove();
    }
  });
});
