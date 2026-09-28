import { assert } from "chai";
import {
  findMetadataCoverURI,
  MAX_SEARCH_RESULTS,
} from "../src/modules/covers/metadataCover";

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
  const queryPath = (title: string, author: string) => {
    const query = JSON.stringify([title.trim(), author.trim()]);
    return PathUtils.join(
      directory(),
      "search",
      `${Zotero.Utilities.Internal.sha1(query)}.json`,
    );
  };
  const searchResponse = (docs: unknown[]) => ({
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify({ docs })),
  });
  const clear = async () => {
    for (const key of [edition, otherEdition]) {
      for (const extension of ["jpg", "missing"])
        await IOUtils.remove(path(key, extension), { ignoreAbsent: true });
    }
    for (const [title, author] of [
      ["A Study in Scarlet", "Doyle, Arthur Conan"],
      ["Title", "Author"],
      ["Another Title", "Author"],
      ["Different Title", "Author"],
      ["Title", "Other Author"],
    ]) {
      await IOUtils.remove(queryPath(title, author), { ignoreAbsent: true });
      const url = `https://openlibrary.org/search.json?q=title:${encodeURIComponent(title)}%20author:${encodeURIComponent(author)}`;
      await IOUtils.remove(
        PathUtils.join(
          directory(),
          "search",
          `${Zotero.Utilities.Internal.sha1(url)}.json`,
        ),
        { ignoreAbsent: true },
      );
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
    ]);
    assert.equal(first, Zotero.File.pathToFileURI(path(edition, "jpg")));
    assert.equal(second, first);
    assert.deepEqual(
      Array.from(await IOUtils.read(path(edition, "jpg"))),
      Array.from(jpeg),
    );
  });

  it("reuses a saved search across lookups but searches a changed title", async function () {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([{ cover_edition_key: edition }])
        : { status: 200, bytes: jpeg };
    };
    await findMetadataCoverURI("Title", "Author", request);
    await findMetadataCoverURI("Title", "Author", request);
    await findMetadataCoverURI("Different Title", "Author", request);
    await findMetadataCoverURI("Title", "Other Author", request);
    assert.equal(urls.filter((url) => url.includes("search.json")).length, 3);
    assert.equal(urls.filter((url) => url.includes("/olid/")).length, 1);
  });

  it("reads a cached title/author tuple without storing the request URL", async function () {
    await IOUtils.makeDirectory(PathUtils.join(directory(), "search"), {
      createAncestors: true,
    });
    await IOUtils.writeUTF8(
      queryPath("Title", "Author"),
      JSON.stringify({
        query: JSON.stringify(["Title", "Author"]),
        key: edition,
        timestamp: Date.now(),
      }),
    );
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return { status: 200, bytes: jpeg };
    };
    assert.equal(
      await findMetadataCoverURI(" Title ", "Author", request),
      Zotero.File.pathToFileURI(path(edition, "jpg")),
    );
    assert.deepEqual(urls, [
      `https://covers.openlibrary.org/b/olid/${edition}-L.jpg?default=false`,
    ]);
  });

  it("caches searches without a cover edition temporarily", async function () {
    let requests = 0;
    const request = async () => {
      requests++;
      return searchResponse([]);
    };
    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.isNull(await findMetadataCoverURI("Title", "Author", request));
    assert.equal(requests, 1);
  });

  it("retries stale search results instead of using an old edition", async function () {
    const cache = queryPath("Title", "Author");
    await IOUtils.makeDirectory(PathUtils.join(directory(), "search"), {
      createAncestors: true,
    });
    const query = JSON.stringify(["Title", "Author"]);
    await IOUtils.writeUTF8(
      cache,
      JSON.stringify({
        query,
        key: otherEdition,
        timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000,
      }),
    );
    const urls: string[] = [];
    const request = async (requestedURL: string) => {
      urls.push(requestedURL);
      return requestedURL.includes("search.json")
        ? searchResponse([{ cover_edition_key: edition }])
        : { status: 200, bytes: jpeg };
    };
    assert.equal(
      await findMetadataCoverURI("Title", "Author", request),
      Zotero.File.pathToFileURI(path(edition, "jpg")),
    );
    assert.deepEqual(urls, [
      "https://openlibrary.org/search.json?q=title:Title%20author:Author",
      `https://covers.openlibrary.org/b/olid/${edition}-L.jpg?default=false`,
    ]);
  });

  it("redownloads a removed JPEG without repeating the metadata search", async function () {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([{ cover_edition_key: edition }])
        : { status: 200, bytes: jpeg };
    };
    await findMetadataCoverURI("Title", "Author", request);
    await IOUtils.remove(path(edition, "jpg"));
    await findMetadataCoverURI("Title", "Author", request);
    assert.equal(urls.filter((url) => url.includes("search.json")).length, 1);
    assert.equal(urls.filter((url) => url.includes("/olid/")).length, 2);
  });

  it("does not search without both fields", async function () {
    let requests = 0;
    const request = async () => {
      requests++;
      return searchResponse([]);
    };
    assert.isNull(await findMetadataCoverURI("", "Author", request));
    assert.isNull(await findMetadataCoverURI("Title", " ", request));
    assert.equal(requests, 0);
  });

  it("uses the first valid cover edition within MAX_SEARCH_RESULTS", async function () {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([
            { isbn: ["9780385533225"] },
            null,
            { cover_edition_key: "../other" },
            { cover_edition_key: otherEdition },
            { cover_edition_key: edition },
          ])
        : { status: 200, bytes: jpeg };
    };
    assert.equal(
      await findMetadataCoverURI("Title", "Author", request),
      Zotero.File.pathToFileURI(path(otherEdition, "jpg")),
    );
    assert.lengthOf(urls, 2);
    assert.include(urls[1], `/olid/${otherEdition}-L.jpg`);
  });

  it("checks result MAX_SEARCH_RESULTS but not the next result", async function () {
    const urls: string[] = [];
    const withoutKeys = Array.from(
      { length: MAX_SEARCH_RESULTS - 1 },
      () => ({}),
    );
    const request = async (url: string) => {
      urls.push(url);
      return url.includes("search.json")
        ? searchResponse([
            ...withoutKeys,
            { cover_edition_key: edition },
            { cover_edition_key: otherEdition },
          ])
        : { status: 200, bytes: jpeg };
    };
    assert.equal(
      await findMetadataCoverURI("Title", "Author", request),
      Zotero.File.pathToFileURI(path(edition, "jpg")),
    );
    assert.include(urls[1], `/olid/${edition}-L.jpg`);

    urls.length = 0;
    assert.isNull(
      await findMetadataCoverURI("Another Title", "Author", async (url) => {
        urls.push(url);
        return searchResponse([
          ...withoutKeys,
          {},
          { cover_edition_key: otherEdition },
        ]);
      }),
    );
    assert.lengthOf(urls, 1);
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
    let started!: () => void;
    const searchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: ReturnType<typeof searchResponse>) => void;
    let requests = 0;
    const request = async (url: string) => {
      requests++;
      if (url.includes("search.json"))
        return new Promise<ReturnType<typeof searchResponse>>((resolve) => {
          release = resolve;
          started();
        });
      return { status: 200, bytes: jpeg };
    };
    const first = findMetadataCoverURI("Title", "Author", request);
    const second = findMetadataCoverURI("Title", "Author", request);
    assert.strictEqual(first, second);
    await searchStarted;
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
