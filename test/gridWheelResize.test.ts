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
