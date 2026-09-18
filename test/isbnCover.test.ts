import { assert } from "chai";
import { findISBNCoverURI } from "../src/modules/isbnCover";

describe("ISBN cover discovery", function () {
  function cacheDirectory(): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      "open-library",
    );
  }

  function cachePaths(isbn: string): string[] {
    return [
      PathUtils.join(cacheDirectory(), `${isbn}.jpg`),
      PathUtils.join(cacheDirectory(), `${isbn}.missing`),
    ];
  }

  async function clearCache(isbn: string): Promise<void> {
    await Promise.all(
      cachePaths(isbn).map((path) =>
        IOUtils.remove(path, { ignoreAbsent: true }),
      ),
    );
  }

  it("downloads, caches, and reuses a cover for a normalized ISBN", async function () {
    const isbn = "9780385533225";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    let requests = 0;
    let requestedURL = "";
    const request = async (url: string) => {
      requests++;
      requestedURL = url;
      return { status: 200, bytes };
    };

    await clearCache(isbn);
    try {
      const first = await findISBNCoverURI("978-0-385-53322-5", request);
      const second = await findISBNCoverURI(isbn, request);

      assert.equal(
        requestedURL,
        `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      );
      assert.equal(first, Zotero.File.pathToFileURI(cachePaths(isbn)[0]));
      assert.equal(second, first);
      assert.equal(requests, 1);
      assert.deepEqual(
        Array.from(await IOUtils.read(cachePaths(isbn)[0])),
        [0xff, 0xd8, 0xff, 0xd9],
      );
    } finally {
      await clearCache(isbn);
    }
  });

  it("caches a missing Open Library cover", async function () {
    const isbn = "0385472579";
    let requests = 0;
    const request = async () => {
      requests++;
      return { status: 404, bytes: new Uint8Array() };
    };

    await clearCache(isbn);
    try {
      assert.isNull(await findISBNCoverURI(isbn, request));
      assert.isNull(await findISBNCoverURI(isbn, request));
      assert.equal(requests, 1);
    } finally {
      await clearCache(isbn);
    }
  });

  it("does not request invalid ISBNs", async function () {
    let requests = 0;

    assert.isNull(
      await findISBNCoverURI("978-0-385-53322-6", async () => {
        requests++;
        return { status: 200, bytes: new Uint8Array() };
      }),
    );
    assert.equal(requests, 0);
  });

  it("rejects a successful response that is not a JPEG", async function () {
    const isbn = "9780385533225";
    await clearCache(isbn);
    try {
      let error: unknown;
      try {
        await findISBNCoverURI(isbn, async () => ({
          status: 200,
          bytes: new Uint8Array([1, 2, 3]),
        }));
      } catch (caught) {
        error = caught;
      }
      assert.match(String(error), /Invalid Open Library cover response/);
    } finally {
      await clearCache(isbn);
    }
  });
});
