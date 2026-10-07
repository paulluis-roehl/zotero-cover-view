import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";

describe("grid wheel resizing", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("preserves the visible item, native selection and selection anchor through wheel and preference resizing", async function () {
    this.timeout(120000);
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originalStyle = grid.style.cssText;
    const originalSize = getPref("tileSize");
    const originallyHidden = grid.hidden;
    const collection = new Zotero.Collection();
    const items: Zotero.Item[] = [];
    let preferences: Window | undefined;
    const waitFor = async (
      condition: () => boolean,
      message = "Resize condition",
    ) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(
        condition(),
        `${message}; columns ${columns()}, size ${getPref("tileSize")}, items ${grid.querySelectorAll(".grid-view-item").length}`,
      );
    };
    const tile = (index: number) =>
      grid.querySelector<HTMLElement>(`[data-item-id="${items[index].id}"]`)!;
    const columns = () =>
      win.getComputedStyle(grid)!.gridTemplateColumns.split(/\s+/).length;
    try {
      collection.name = `Resize anchor ${Date.now()}`;
      collection.libraryID = Zotero.Libraries.userLibraryID;
      await collection.saveTx();
      await Zotero.DB.executeTransaction(async () => {
        for (let index = 0; index < 40; index++) {
          const item = new Zotero.Item("book");
          item.setField(
            "title",
            `Resize anchor ${collection.id} ${String(index).padStart(2, "0")}`,
          );
          item.addToCollection(collection.id);
          await item.save();
          items.push(item);
        }
      });
      await pane.collectionsView!.selectByID(`C${collection.id}`);
      if (grid.hidden) button.dispatchEvent(new win.Event("command"));
      grid.style.cssText +=
        ";flex:none;box-sizing:border-box;width:630px;height:300px;padding:19px;gap:20px;grid-template-columns:repeat(auto-fill,minmax(var(--cover-view-tile-size),1fr))";
      setPref("tileSize", 180);
      await waitFor(
        () => !!tile(6) && columns() === 3,
        "Initial three-column layout",
      );
      tile(1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => pane.getSelectedItems(true)[0] === items[1].id);
      await waitFor(() => !!tile(3).querySelector("img")?.getAttribute("src"));
      grid.scrollTop = tile(3).offsetTop + 37;
      grid.dispatchEvent(new win.Event("scroll"));
      const anchorID = items[3].id;
      const offset = () =>
        grid
          .querySelector<HTMLElement>(`[data-item-id="${anchorID}"]`)!
          .getBoundingClientRect().top - grid.getBoundingClientRect().top;
      const originalOffset = offset();
      const focused = grid.getAttribute("aria-activedescendant");
      const active = win.document.activeElement;
      const ownsFocus = grid.classList.contains("owns-focus");
      grid.dispatchEvent(
        new win.WheelEvent("wheel", {
          deltaY: -100,
          bubbles: true,
          cancelable: true,
          ...(win.navigator.platform.startsWith("Mac")
            ? { metaKey: true }
            : { ctrlKey: true }),
        }),
      );
      await waitFor(() => columns() === 2, "Wheel changes to two columns");
      assert.closeTo(offset(), originalOffset, 1);
      assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
      assert.equal(grid.getAttribute("aria-activedescendant"), focused);
      assert.strictEqual(win.document.activeElement, active);
      assert.equal(grid.classList.contains("owns-focus"), ownsFocus);

      // Width changes take the observer path, without a tile-size preference update.
      const cover = tile(3).querySelector("img")!;
      const coverURI = cover.getAttribute("src");
      for (const [width, count] of [
        [900, 4],
        [700, 3],
        [450, 2],
        [630, 2],
      ]) {
        grid.style.width = `${width}px`;
        await Zotero.Promise.delay(60);
        await waitFor(() => columns() === count, `Width ${width}px`);
        assert.closeTo(offset(), originalOffset, 1);
        assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
        assert.equal(grid.getAttribute("aria-activedescendant"), focused);
        assert.strictEqual(win.document.activeElement, active);
        assert.equal(grid.classList.contains("owns-focus"), ownsFocus);
        assert.equal(getPref("tileSize"), 189);
        assert.strictEqual(tile(3).querySelector("img"), cover);
        assert.equal(cover.getAttribute("src"), coverURI);
      }

      const preferencePane = Zotero.PreferencePanes.pluginPanes.find(
        (entry) => entry.pluginID === "coverview@insature.net",
      )!;
      preferences = Zotero.Utilities.Internal.openPreferences(
        preferencePane.id,
      )!;
      await waitFor(
        () =>
          !!preferences!.document.getElementById(
            "zotero-prefpane-coverview-tile-size-percent",
          ),
      );
      const percentage = preferences.document.getElementById(
        "zotero-prefpane-coverview-tile-size-percent",
      ) as HTMLInputElement;
      await Zotero.Promise.delay(400);
      const preferenceAnchor = tile(2);
      const preferenceOffset =
        preferenceAnchor.getBoundingClientRect().top -
        grid.getBoundingClientRect().top;
      const inactiveOwner = grid.classList.contains("owns-focus");
      const inactiveFocus = win.document.activeElement;
      percentage.value = "100";
      percentage.dispatchEvent(
        new (preferences as Window & typeof globalThis).Event("input", {
          bubbles: true,
        }),
      );
      await waitFor(() => columns() === 3 && getPref("tileSize") === 180);
      assert.closeTo(
        preferenceAnchor.getBoundingClientRect().top -
          grid.getBoundingClientRect().top,
        preferenceOffset,
        1,
      );
      assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
      assert.equal(grid.getAttribute("aria-activedescendant"), focused);
      assert.equal(grid.classList.contains("owns-focus"), inactiveOwner);
      assert.strictEqual(win.document.activeElement, inactiveFocus);
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(() => pane.getSelectedItems(true).length === 2);
      assert.sameMembers(
        pane.getSelectedItems(true),
        [items[1].id, items[2].id],
        "Shift selection still extends from the original selection anchor",
      );
      assert.isAtMost(grid.querySelectorAll(".grid-view-item").length, 25);
    } finally {
      preferences?.close();
      grid.style.cssText = originalStyle;
      setPref("tileSize", originalSize);
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new win.Event("command"));
      await pane.collectionsView!.selectLibrary(Zotero.Libraries.userLibraryID);
      for (const item of items) if (item.id) await item.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });

  it("resizes by five percent per notch and accumulates smooth and line deltas", async function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originalSize = getPref("tileSize");
    const originallyHidden = grid.hidden;
    const primary = win.navigator.platform.startsWith("Mac")
      ? { metaKey: true }
      : { ctrlKey: true };
    const wheel = (deltaY: number, deltaMode = 0) => {
      const event = new win.WheelEvent("wheel", {
        deltaY,
        deltaMode,
        ...primary,
        bubbles: true,
        cancelable: true,
      });
      grid.dispatchEvent(event);
      assert.isTrue(event.defaultPrevented);
    };
    const waitForSize = async (size: number) => {
      const deadline = Date.now() + 3000;
      while (
        grid.style.getPropertyValue("--cover-view-tile-size") !== `${size}px` &&
        Date.now() < deadline
      )
        await Zotero.Promise.delay(20);
      assert.equal(getPref("tileSize"), size);
      assert.equal(
        grid.style.getPropertyValue("--cover-view-tile-size"),
        `${size}px`,
      );
    };

    try {
      if (grid.hidden) button.dispatchEvent(new win.Event("command"));
      setPref("tileSize", 180);
      await waitForSize(180);
      wheel(-40);
      wheel(-60);
      await waitForSize(189);
      wheel(200);
      await waitForSize(171);
      wheel(-1, 2);
      await waitForSize(180);
      wheel(1, 1);
      wheel(2, 1);
      await waitForSize(171);

      setPref("tileSize", 351);
      await waitForSize(351);
      wheel(-100);
      await waitForSize(360);
      wheel(-100);
      await waitForSize(360);
      wheel(-40);
      wheel(100);
      await waitForSize(351);
      setPref("tileSize", 99);
      await waitForSize(99);
      wheel(100);
      await waitForSize(90);
      wheel(40);
      wheel(-100);
      await waitForSize(99);
      wheel(100);
      await waitForSize(90);
    } finally {
      setPref("tileSize", originalSize);
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new win.Event("command"));
    }
  });

  it("leaves unrelated gestures and wheel events outside the grid alone", function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const originalSize = getPref("tileSize");
    const isMac = win.navigator.platform.startsWith("Mac");
    const primary = isMac ? { metaKey: true } : { ctrlKey: true };
    const wheel = (target: Element, modifiers = {}) => {
      const event = new win.WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      target.dispatchEvent(event);
      return event;
    };
    try {
      if (grid.hidden) button.dispatchEvent(new win.Event("command"));
      setPref("tileSize", 180);
      assert.isFalse(wheel(grid).defaultPrevented);
      assert.isFalse(
        wheel(grid, isMac ? { ctrlKey: true } : { metaKey: true })
          .defaultPrevented,
      );
      assert.isFalse(
        wheel(grid, { ...primary, altKey: true }).defaultPrevented,
      );
      assert.isFalse(
        wheel(grid, { ...primary, shiftKey: true }).defaultPrevented,
      );
      assert.isFalse(wheel(button, primary).defaultPrevented);
      assert.equal(getPref("tileSize"), 180);
      assert.isTrue(wheel(grid, primary).defaultPrevented);
      assert.equal(getPref("tileSize"), 189);
    } finally {
      setPref("tileSize", originalSize);
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new win.Event("command"));
    }
  });

  it("uses Cmd on macOS and Ctrl on Windows/Linux, and ignores a hidden grid", function () {
    const win = Zotero.getMainWindow()!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originalSize = getPref("tileSize");
    const originallyHidden = grid.hidden;
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      win.navigator,
      "platform",
    );
    const wheel = (modifiers: { ctrlKey?: boolean; metaKey?: boolean }) => {
      const event = new win.WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      grid.dispatchEvent(event);
      return event;
    };

    try {
      if (grid.hidden) button.dispatchEvent(new win.Event("command"));
      setPref("tileSize", 180);
      for (const [platform, primary, other] of [
        ["MacIntel", { metaKey: true }, { ctrlKey: true }],
        ["Win32", { ctrlKey: true }, { metaKey: true }],
        ["Linux x86_64", { ctrlKey: true }, { metaKey: true }],
      ] as const) {
        Object.defineProperty(win.navigator, "platform", {
          configurable: true,
          value: platform,
        });
        assert.isFalse(wheel(other).defaultPrevented);
        assert.isTrue(wheel(primary).defaultPrevented);
      }
      assert.equal(getPref("tileSize"), 207);
      button.dispatchEvent(new win.Event("command"));
      assert.isTrue(grid.hidden);
      assert.isFalse(wheel({ ctrlKey: true }).defaultPrevented);
      assert.equal(getPref("tileSize"), 207);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(win.navigator, "platform", platformDescriptor);
      } else {
        Reflect.deleteProperty(win.navigator, "platform");
      }
      setPref("tileSize", originalSize);
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new win.Event("command"));
    }
  });

  it("keeps the settings slider synchronized with a wheel change", async function () {
    const main = Zotero.getMainWindow()!;
    const grid = main.document.getElementById("cover-view-grid")!;
    const button = main.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const originalSize = getPref("tileSize");
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (entry) => entry.pluginID === "coverview@insature.net",
    )!;
    const win = Zotero.Utilities.Internal.openPreferences(pane.id)!;
    try {
      if (grid.hidden) button.dispatchEvent(new main.Event("command"));
      setPref("tileSize", 180);
      const sliderID = "zotero-prefpane-coverview-tile-size";
      const deadline = Date.now() + 5000;
      const slider = () =>
        win.document.getElementById(sliderID) as HTMLInputElement | null;
      while (slider()?.value !== "180" && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.equal(slider()?.value, "180");
      grid.dispatchEvent(
        new main.WheelEvent("wheel", {
          deltaY: -100,
          bubbles: true,
          cancelable: true,
          ...(main.navigator.platform.startsWith("Mac")
            ? { metaKey: true }
            : { ctrlKey: true }),
        }),
      );
      while (slider()?.value !== "189" && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.equal(getPref("tileSize"), 189);
      assert.equal(slider()?.value, "189");
    } finally {
      setPref("tileSize", originalSize);
      if (grid.hidden !== originallyHidden)
        button.dispatchEvent(new main.Event("command"));
      win.close();
    }
  });
});
