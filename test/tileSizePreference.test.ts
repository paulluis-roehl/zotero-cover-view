import { assert } from "chai";
import { attachTileSizePreference } from "../src/modules/tileSizePreference";
import { getPref, setPref } from "../src/utils/prefs";

describe("tile size preference controls", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("keeps a percentage entry and slider synchronized within 50–200%", function () {
    const doc = Zotero.getMainWindow()!.document;
    const slider = doc.createElement("input");
    const percentage = doc.createElement("input");
    slider.type = "range";
    slider.min = "90";
    slider.max = "360";
    slider.step = "1";
    percentage.type = "number";
    const originalSize = getPref("tileSize");
    setPref("tileSize", 180);
    const detach = attachTileSizePreference(slider, percentage);

    try {
      assert.equal(percentage.value, "100");
      slider.value = "270";
      slider.dispatchEvent(new doc.defaultView!.Event("input"));
      assert.equal(percentage.value, "150");

      percentage.value = "125";
      percentage.dispatchEvent(new doc.defaultView!.Event("input"));
      assert.equal(slider.value, "225");
      assert.equal(getPref("tileSize"), 225);

      percentage.value = "201";
      percentage.dispatchEvent(new doc.defaultView!.Event("input"));
      assert.equal(getPref("tileSize"), 225, "Out-of-range input is not saved");
      percentage.dispatchEvent(new doc.defaultView!.Event("change"));
      assert.equal(percentage.value, "200");
      assert.equal(slider.value, "360");

      percentage.value = "";
      percentage.dispatchEvent(new doc.defaultView!.Event("change"));
      assert.equal(percentage.value, "200", "Empty input restores the size");

      setPref("tileSize", 90);
      slider.value = "90";
      slider.dispatchEvent(new doc.defaultView!.Event("syncfrompreference"));
      assert.equal(percentage.value, "50");
    } finally {
      detach();
      setPref("tileSize", originalSize);
    }
  });

  it("connects the percentage entry to Zotero's preference pane slider", async function () {
    const originalSize = getPref("tileSize");
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (entry) => entry.pluginID === "coverview@insature.net",
    )!;
    const win = Zotero.Utilities.Internal.openPreferences(pane.id)!;
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(
        condition(),
        "Preference pane should synchronize both inputs",
      );
    };

    try {
      setPref("tileSize", 180);
      const sliderID = "zotero-prefpane-coverview-tile-size";
      const percentID = `${sliderID}-percent`;
      await waitFor(() => {
        const percent = win.document.getElementById(
          percentID,
        ) as HTMLInputElement;
        return percent?.value === "100";
      });
      const slider = win.document.getElementById(sliderID) as HTMLInputElement;
      const percent = win.document.getElementById(
        percentID,
      ) as HTMLInputElement;

      slider.value = "270";
      slider.dispatchEvent(new win.Event("input", { bubbles: true }));
      await waitFor(
        () => percent.value === "150" && getPref("tileSize") === 270,
      );

      percent.value = "125";
      percent.dispatchEvent(new win.Event("input", { bubbles: true }));
      await waitFor(
        () => slider.value === "225" && getPref("tileSize") === 225,
      );
    } finally {
      setPref("tileSize", originalSize);
      win.close();
    }
  });
});
