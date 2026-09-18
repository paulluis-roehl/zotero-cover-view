import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { getPref, observePrefs, setPref } from "../src/utils/prefs";

describe("preferences", function () {
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

  it("exposes the ISBN cover preference to the cover provider", function () {
    const originalFetchISBNCover = getPref("fetchISBNCover");

    try {
      setPref("fetchISBNCover", true);
      assert.isTrue(CoverProvider.shouldFetchISBNCover());
      setPref("fetchISBNCover", false);
      assert.isFalse(CoverProvider.shouldFetchISBNCover());
    } finally {
      setPref("fetchISBNCover", originalFetchISBNCover);
    }
  });
});
