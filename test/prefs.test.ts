import { assert } from "chai";
import { getPref, observePrefs, setPref } from "../src/utils/prefs";

describe("preference observers", function () {
  it("observes a key and stops notifying after cleanup", function () {
    const originalShowAuthors = getPref("showAuthors");
    let calls = 0;
    const stop = observePrefs(["showAuthors"], () => calls++);

    try {
      setPref("showAuthors", !originalShowAuthors);
      assert.equal(calls, 1);

      stop();
      stop();
      setPref("showAuthors", originalShowAuthors);
      assert.equal(calls, 1);
    } finally {
      stop();
      setPref("showAuthors", originalShowAuthors);
    }
  });
});
