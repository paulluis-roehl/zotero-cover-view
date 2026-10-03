import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { getPref, observePrefs, setPref } from "../src/utils/prefs";

describe("preferences", function () {
  it("observes a key and stops notifying after cleanup", function () {
    const originalShowAuthors = getPref("showCreators");
    let calls = 0;
    const stop = observePrefs(["showCreators"], () => calls++);

    try {
      setPref("showCreators", !originalShowAuthors);
      assert.equal(calls, 1);

      stop();
      stop();
      setPref("showCreators", originalShowAuthors);
      assert.equal(calls, 1);
    } finally {
      stop();
      setPref("showCreators", originalShowAuthors);
    }
  });
});
