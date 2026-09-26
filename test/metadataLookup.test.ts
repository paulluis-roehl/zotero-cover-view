import { assert } from "chai";
import { findMetadataCoverURI } from "../src/modules/covers/metadataCover";

describe("standalone metadata cover discovery", function () {
  const edition = "OL12345M";
  const otherEdition = "OL98765M";
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const directory = () =>
    PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      "open-library",
      "olid",
    );
  const path = (key: string, extension: string) =>
    PathUtils.join(directory(), `${key}.${extension}`);
  const searchResponse = (docs: object[]) => ({
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify({ docs })),
  });
  const clear = async () => {
    for (const key of [edition, otherEdition]) {
      for (const extension of ["jpg", "missing"])
        await IOUtils.remove(path(key, extension), { ignoreAbsent: true });
    }
  };

  beforeEach(clear);

  afterEach(clear);

  it("searches by title and author and caches the first result's cover edition", async function () {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([
            { cover_edition_key: edition },
            { cover_edition_key: otherEdition },
          ])
        : { status: 200, bytes: jpeg };
    };

    const first = await findMetadataCoverURI(
      " A Study in Scarlet ",
      "Doyle, Arthur Conan",
      request,
    );
    const second = await findMetadataCoverURI(
      "A Study in Scarlet",
      "Doyle, Arthur Conan",
      request,
    );

    assert.deepEqual(urls, [
      "https://openlibrary.org/search.json?q=title:A%20Study%20in%20Scarlet%20author:Doyle%2C%20Arthur%20Conan",
      `https://covers.openlibrary.org/b/olid/${edition}-L.jpg?default=false`,
      "https://openlibrary.org/search.json?q=title:A%20Study%20in%20Scarlet%20author:Doyle%2C%20Arthur%20Conan",
    ]);
    assert.equal(first, Zotero.File.pathToFileURI(path(edition, "jpg")));
    assert.equal(second, first);
    assert.deepEqual(
      Array.from(await IOUtils.read(path(edition, "jpg"))),
      Array.from(jpeg),
    );
  });

  it("does not search without both fields or a first result with a cover edition", async function () {
    let requests = 0;
    const request = async () => {
      requests++;
      return searchResponse([
        { isbn: ["9780385533225"] },
        { cover_edition_key: edition },
      ]);
    };
    assert.isNull(await findMetadataCoverURI("", "Author", request));
    assert.isNull(await findMetadataCoverURI("Title", " ", request));
    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.equal(requests, 1);
  });

  it("rejects unsafe edition keys rather than requesting an arbitrary path", async function () {
    let requests = 0;
    const request = async () => {
      requests++;
      return searchResponse([{ cover_edition_key: "../other" }]);
    };
    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.equal(requests, 1);
  });

  it("caches 404 cover responses for a week", async function () {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([{ cover_edition_key: edition }])
        : { status: 404, bytes: new Uint8Array() };
    };

    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.equal(urls.filter((url) => url.includes("/olid/")).length, 1);
    assert.isTrue(
      Number.isFinite(Number(await IOUtils.readUTF8(path(edition, "missing")))),
    );
  });

  it("deduplicates simultaneous lookups", async function () {
    let release!: (value: ReturnType<typeof searchResponse>) => void;
    let requests = 0;
    const request = async (url: string) => {
      requests++;
      if (url.includes("search.json"))
        return new Promise<ReturnType<typeof searchResponse>>((resolve) => {
          release = resolve;
        });
      return { status: 200, bytes: jpeg };
    };
    const first = findMetadataCoverURI("Title", "Author", request);
    const second = findMetadataCoverURI("Title", "Author", request);
    assert.strictEqual(first, second);
    release(searchResponse([{ cover_edition_key: edition }]));
    assert.equal(await first, Zotero.File.pathToFileURI(path(edition, "jpg")));
    assert.equal(requests, 2);
  });

  it("rejects invalid JPEG bytes without caching them", async function () {
    const request = async (url: string) =>
      url.includes("search.json")
        ? searchResponse([{ cover_edition_key: edition }])
        : { status: 200, bytes: new Uint8Array([1, 2, 3]) };
    let error: unknown;
    try {
      await findMetadataCoverURI("Title", "Author", request);
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /Invalid Open Library cover response/);
    assert.isFalse(await IOUtils.exists(path(edition, "jpg")));
  });
});
