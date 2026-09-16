import { assert } from "chai";
import { getPref, observePrefs, setPref } from "../src/utils/prefs";

describe("preference observers", function () {
  it("observes multiple keys and stops notifying after cleanup", function () {
    const originalShowAuthors = getPref("showAuthors");
    const originalInput = getPref("input");
    let calls = 0;
    const stop = observePrefs(["showAuthors", "input"], () => calls++);

    try {
      setPref("showAuthors", !originalShowAuthors);
      assert.equal(calls, 1);
      setPref("input", `${originalInput} changed`);
      assert.equal(calls, 2);

      stop();
      stop();
      setPref("showAuthors", originalShowAuthors);
      setPref("input", originalInput);
      assert.equal(calls, 2);
    } finally {
      stop();
      setPref("showAuthors", originalShowAuthors);
      setPref("input", originalInput);
    }
  });
});
