import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import { CoverProvider } from "../src/modules/coverProvider";
import { getPref, setPref } from "../src/utils/prefs";
import { findISBNCoverURI } from "../src/modules/covers/isbnCover";
import { findMetadataCoverURI } from "../src/modules/covers/metadataCover";

describe("Cover provider", function () {
  let originalGet: typeof Zotero.Items.get;
  let originalRegister: typeof Zotero.Notifier.registerObserver;
  let originalFetchISBNCover: boolean;
  let originalRead: typeof IOUtils.read;
  let toolkitDescriptor: PropertyDescriptor | undefined;

  function attachment(
    id: number,
    contentType: string,
    filePath: string,
  ): Zotero.Item {
    return {
      id,
      attachmentContentType: contentType,
      attachmentReaderType:
        contentType === "application/pdf"
          ? "pdf"
          : contentType === "application/epub+zip"
            ? "epub"
            : undefined,
      isFileAttachment: () => true,
      isRegularItem: () => false,
      getFilePathAsync: async () => filePath,
    } as unknown as Zotero.Item;
  }

  function parent(attachments: Zotero.Item[], isbn = ""): Zotero.Item {
    Zotero.Items.get = (() => attachments) as typeof originalGet;
    return {
      id: 42,
      firstCreator: "Test Author",
      isFileAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => attachments.map(({ id }) => id).reverse(),
      getBestAttachments: async () => attachments,
      getDisplayTitle: () => "Test Book",
      getField: (field: string) => (field === "ISBN" ? isbn : ""),
    } as unknown as Zotero.Item;
  }

  beforeEach(function () {
    originalGet = Zotero.Items.get;
    originalRegister = Zotero.Notifier.registerObserver;
    originalFetchISBNCover = getPref("fetchISBNCover");
    originalRead = IOUtils.read;
    // Relative paths are virtual extraction fixtures; absolute paths exercise
    // real filesystem behavior, including the missing-image regression.
    IOUtils.read = ((path, options) =>
      path.includes("/")
        ? originalRead(path, options)
        : Promise.resolve(new Uint8Array([1]))) as typeof IOUtils.read;
    toolkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ztoolkit");
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: new BasicTool(),
    });
    setPref("fetchISBNCover", false);
  });

  afterEach(function () {
    Zotero.Items.get = originalGet;
    IOUtils.read = originalRead;
    Zotero.Notifier.registerObserver = originalRegister;
    setPref("fetchISBNCover", originalFetchISBNCover);
    if (toolkitDescriptor) {
      Object.defineProperty(globalThis, "ztoolkit", toolkitDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "ztoolkit");
    }
    CoverProvider.clearCache();
  });

  it("reports online provenance without relying on the URI scheme", async function () {
    const item = parent([], "9783570402931");
    const result = await CoverProvider.findCoverResult(
      item,
      async () => null,
      async () => null,
      async () => null,
      async () => "file:///cached-online.jpg",
      undefined,
      true,
    );
    assert.deepEqual(result, {
      uri: "file:///cached-online.jpg",
      source: "online",
    });
  });

  it("identifies image, EPUB, and PDF branches as attachment-derived, including standalone attachments", async function () {
    for (const [type, index] of [
      ["image/png", 2],
      ["application/epub+zip", 0],
      ["application/pdf", 1],
    ] as const) {
      const file = attachment(1, type, "fixture");
      for (const item of [parent([file]), file]) {
        const finders: [
          () => Promise<string | null>,
          () => Promise<string | null>,
          () => Promise<string | null>,
        ] = [async () => null, async () => null, async () => null];
        finders[index] = async () => "https://example.invalid/attachment-cover";
        assert.deepEqual(
          await CoverProvider.findCoverResult(item, ...finders),
          {
            uri: "https://example.invalid/attachment-cover",
            source: "attachment",
          },
        );
      }
    }
  });

  it("identifies a generated placeholder separately from online and attachment covers", async function () {
    const result = await CoverProvider.findCoverResult(
      parent([]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      false,
    );
    assert.equal(result!.source, "placeholder");
    assert.match(result!.uri, /^data:image\/svg\+xml/);
    assert.equal(await CoverProvider.findCover(parent([])), result!.uri);
  });

  it("retains online provenance for both persistent lookup caches after clearing provider memory", async function () {
    const isbn = "9780142410370";
    const title = `Persistent provenance ${Zotero.Utilities.randomString()}`;
    const author = "Test, Author";
    const edition = "OL987654322M";
    const directory = PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      "open-library",
    );
    const paths = [
      PathUtils.join(directory, `${isbn}.jpg`),
      PathUtils.join(directory, `${isbn}.missing`),
      PathUtils.join(directory, "olid", `${edition}.jpg`),
      PathUtils.join(directory, "olid", `${edition}.missing`),
      PathUtils.join(
        directory,
        "olid",
        "search",
        `${Zotero.Utilities.Internal.sha1(JSON.stringify([title, author]))}.json`,
      ),
    ];
    const originalRequest = Zotero.HTTP.request;
    const originalMetadata = getPref("fetchMetadataCover");
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    try {
      for (const path of paths)
        await IOUtils.remove(path, { ignoreAbsent: true });
      const isbnURI = await findISBNCoverURI(isbn, async () => ({
        status: 200,
        bytes,
      }));
      const metadataURI = await findMetadataCoverURI(
        title,
        author,
        async (url) => ({
          status: 200,
          bytes: url.includes("search.json")
            ? new TextEncoder().encode(
                JSON.stringify({ docs: [{ cover_edition_key: edition }] }),
              )
            : bytes,
        }),
      );
      Zotero.HTTP.request = (async () => {
        throw new Error("Persisted lookup must not access the network");
      }) as typeof originalRequest;
      for (const [lookup, uri] of [
        ["isbn", isbnURI],
        ["metadata", metadataURI],
      ]) {
        CoverProvider.clearCache();
        setPref("fetchISBNCover", lookup === "isbn");
        setPref("fetchMetadataCover", lookup === "metadata");
        const item = parent([], lookup === "isbn" ? isbn : "");
        Object.assign(item, {
          itemType: "book",
          getField: (field: string) =>
            field === "title"
              ? title
              : field === "ISBN" && lookup === "isbn"
                ? isbn
                : "",
          getCreatorsJSON: () => [
            { firstName: "Author", lastName: "Test", creatorType: "author" },
          ],
        });
        CoverProvider.cacheCover(item);
        assert.deepEqual(await CoverProvider.getCoverResult(item.id), {
          uri,
          source: "online",
        });
        assert.equal(
          await CoverProvider.getCover(item.id),
          uri,
          "URI-only consumers remain compatible",
        );
      }
    } finally {
      Zotero.HTTP.request = originalRequest;
      setPref("fetchMetadataCover", originalMetadata);
      for (const path of paths)
        await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("uses a PDF attachment when no EPUB attachment exists", async function () {
    const item = parent([attachment(1, "application/pdf", "book.pdf")]);

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => null,
        async (filePath) => `cover:${filePath}`,
      ),
      "cover:book.pdf",
    );
  });

  it("uses Zotero's ranked order rather than image-first format priority", async function () {
    const image = attachment(1, "image/png", "cover.png");
    const item = parent([
      attachment(3, "application/pdf", "book.pdf"),
      attachment(2, "application/epub+zip", "book.epub"),
      image,
    ]);
    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => "cover:book.epub",
        async () => "cover:book.pdf",
        async (filePath) => `cover:${filePath}`,
      ),
      "cover:book.pdf",
    );
  });

  it("uses an EPUB when image attachments have no cover", async function () {
    const item = parent([
      attachment(1, "image/jpeg", "missing.jpg"),
      attachment(2, "application/epub+zip", "book.epub"),
    ]);

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => "cover:book.epub",
        async () => null,
        async () => null,
      ),
      "cover:book.epub",
    );
  });

  it("falls through unsupported candidates, missing paths, path errors, and extraction failures in ranked order", async function () {
    const missingPath = attachment(2, "application/pdf", "");
    const pathError = attachment(3, "application/pdf", "unused.pdf");
    pathError.getFilePathAsync = async () => {
      throw new Error("Path unavailable");
    };
    const item = parent([
      attachment(1, "text/plain", "unsupported.txt"),
      missingPath,
      pathError,
      attachment(4, "application/pdf", "no-cover.pdf"),
      attachment(5, "application/pdf", "broken.pdf"),
      attachment(6, "application/pdf", "winner.pdf"),
      attachment(7, "application/pdf", "later.pdf"),
    ]);
    assert.deepEqual(
      await CoverProvider.findCoverResult(item, undefined, async (path) => {
        if (path === "no-cover.pdf") return null;
        if (path === "broken.pdf") throw new Error("Extraction failed");
        return `cover:${path}`;
      }),
      { uri: "cover:winner.pdf", source: "attachment" },
    );
  });

  it("does not let a real missing image URI hide the next ranked cover", async function () {
    const directory = `/tmp/opencode/missing-cover-${Zotero.Utilities.randomString()}`;
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    try {
      const item = parent([
        attachment(1, "image/png", PathUtils.join(directory, "missing.png")),
        attachment(2, "application/pdf", "book.pdf"),
      ]);
      assert.deepEqual(
        await CoverProvider.findCoverResult(
          item,
          undefined,
          async () => "cover:book.pdf",
        ),
        { uri: "cover:book.pdf", source: "attachment" },
      );
    } finally {
      await IOUtils.remove(directory);
    }
  });

  for (const type of ["image/png", "application/epub+zip", "application/pdf"]) {
    it(`skips an unreadable ${type} candidate before a usable image`, async function () {
      const read = IOUtils.read;
      IOUtils.read = ((path, options) =>
        path === "unreadable"
          ? Promise.reject(new Error("Access denied"))
          : read(path, options)) as typeof IOUtils.read;
      const item = parent([
        attachment(1, type, "unreadable"),
        attachment(2, "image/png", "winner.png"),
        attachment(3, "image/png", "later.png"),
      ]);
      assert.deepEqual(
        await CoverProvider.findCoverResult(
          item,
          async () => "wrong-epub",
          async () => "wrong-pdf",
          async (path) => `cover:${path}`,
        ),
        { uri: "cover:winner.png", source: "attachment" },
      );
    });
  }

  it("falls back to ISBN, optional metadata, then placeholder only after all ranked candidates fail", async function () {
    const item = parent(
      [
        attachment(1, "image/png", "broken.png"),
        attachment(2, "application/epub+zip", "no-cover.epub"),
        attachment(3, "application/pdf", "broken.pdf"),
      ],
      "9783570402931",
    );
    Object.assign(item, {
      itemType: "book",
      getField: (field: string) =>
        field === "title"
          ? "Test Book"
          : field === "ISBN"
            ? "9783570402931"
            : "",
      getCreatorsJSON: () => [{ lastName: "Author", creatorType: "author" }],
    });
    for (const expected of ["isbn", "metadata", "placeholder"]) {
      const result = await CoverProvider.findCoverResult(
        item,
        async () => null,
        async () => {
          throw new Error("PDF extraction failed");
        },
        async () => {
          throw new Error("Image resolver failed");
        },
        async () => (expected === "isbn" ? "cover:isbn" : null),
        undefined,
        true,
        async () => (expected === "metadata" ? "cover:metadata" : null),
        true,
      );
      if (expected === "placeholder") {
        assert.equal(result?.source, "placeholder");
      } else {
        assert.deepEqual(result, {
          uri: `cover:${expected}`,
          source: "online",
        });
      }
    }
  });

  it("preserves a supplied EPUB-before-PDF ranking", async function () {
    const item = parent([
      attachment(1, "application/epub+zip", "book.epub"),
      attachment(2, "application/pdf", "book.pdf"),
    ]);
    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => "cover:book.epub",
        async () => "cover:book.pdf",
      ),
      "cover:book.epub",
    );
  });

  it("consumes native ranking and refreshes cached covers through real Zotero notifications", async function () {
    const directory = `/tmp/opencode/ranked-covers-${Zotero.Utilities.randomString()}`;
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    const item = new Zotero.Item("book");
    const other = new Zotero.Item("book");
    const files: Zotero.Item[] = [];
    const changes: number[] = [];
    const stop = CoverProvider.onCoverChanged((id) => changes.push(id));
    const urlA = "https://example.invalid/a";
    const urlB = "https://example.invalid/b";
    async function addImage(name: string, url: string, date: string) {
      const path = PathUtils.join(directory, name);
      await IOUtils.write(path, new Uint8Array([1]));
      const file = new Zotero.Item("attachment");
      file.parentItemID = item.id;
      file.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
      file.attachmentContentType = "image/png";
      file.attachmentPath = path;
      file.setField("url", url);
      file.setField("dateAdded", date);
      await file.saveTx();
      files.push(file);
      return file;
    }
    async function expectCover(parent: Zotero.Item, file: Zotero.Item) {
      CoverProvider.cacheCover(parent);
      assert.deepEqual(await CoverProvider.getCoverResult(parent.id), {
        uri: Zotero.File.pathToFileURI(
          (await file.getFilePathAsync()) as string,
        ),
        source: "attachment",
      });
    }
    function expectRefresh(...parents: Zotero.Item[]) {
      for (const parent of parents) assert.include(changes, parent.id);
      changes.length = 0;
    }
    try {
      item.setField("title", "Native ranked cover fixture");
      item.setField("url", urlA);
      await item.saveTx();
      await other.saveTx();
      const a = await addImage("a.png", urlA, "2020-01-01 00:00:00");
      const b = await addImage("b.png", urlB, "2021-01-01 00:00:00");
      CoverProvider.registerNotifier();
      assert.equal((await item.getBestAttachments())[0].id, a.id);
      await expectCover(item, a);

      item.setField("url", urlB);
      await item.saveTx();
      assert.equal((await item.getBestAttachments())[0].id, b.id);
      expectRefresh(item);
      await expectCover(item, b);

      b.setField("url", urlA);
      await b.saveTx();
      expectRefresh(item);
      await expectCover(item, a);

      const c = await addImage("c.png", urlB, "2022-01-01 00:00:00");
      expectRefresh(item);
      await expectCover(item, c);
      CoverProvider.cacheCover(other);
      assert.equal(
        (await CoverProvider.getCoverResult(other.id))?.source,
        "placeholder",
      );
      c.parentItemID = other.id;
      await c.saveTx();
      expectRefresh(item, other);
      await expectCover(item, a);
      await expectCover(other, c);

      // b was ranked after the winner and never resolved, but is still tracked.
      await b.eraseTx();
      files.splice(files.indexOf(b), 1);
      expectRefresh(item);
      await expectCover(item, a);
      await a.eraseTx();
      files.splice(files.indexOf(a), 1);
      expectRefresh(item);
      CoverProvider.cacheCover(item);
      assert.equal(
        (await CoverProvider.getCoverResult(item.id))?.source,
        "placeholder",
      );
    } finally {
      stop();
      CoverProvider.unregisterNotifier();
      for (const file of files) await file.eraseTx();
      if (item.id) await item.eraseTx();
      if (other.id) await other.eraseTx();
      await IOUtils.remove(directory, { recursive: true });
    }
  });

  it("uses a PDF when EPUB attachments have no cover", async function () {
    const item = parent([
      attachment(1, "application/epub+zip", "book.epub"),
      attachment(2, "application/pdf", "book.pdf"),
    ]);

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => null,
        async () => "cover:book.pdf",
      ),
      "cover:book.pdf",
    );
  });

  it("accepts a PDF attachment directly", async function () {
    assert.equal(
      await CoverProvider.findCover(
        attachment(1, "application/pdf", "book.pdf"),
        async () => null,
        async (filePath) => `cover:${filePath}`,
      ),
      "cover:book.pdf",
    );
  });

  it("accepts an image attachment directly", async function () {
    const image = attachment(1, "image/webp", "cover.webp");

    assert.equal(
      await CoverProvider.findCover(
        image,
        async () => null,
        async () => null,
        async (filePath) => `cover:${filePath}`,
      ),
      "cover:cover.webp",
    );
  });

  it("uses an ISBN cover after local attachments have no cover", async function () {
    const item = parent([], "978-3-570-40293-1 978-3-570-16711-3");
    const lookups: string[] = [];
    setPref("fetchISBNCover", true);

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => null,
        async () => null,
        async () => null,
        async (isbn) => {
          lookups.push(isbn);
          if (isbn === "9783570402931") throw new Error("lookup failed");
          return `cover:${isbn}`;
        },
      ),
      "cover:9783570167113",
    );
    assert.deepEqual(lookups, ["9783570402931", "9783570167113"]);
  });

  it("does not use ISBN lookup when the preference is disabled", async function () {
    const item = parent([], "978-3-570-40293-1");
    let lookups = 0;

    const cover = await CoverProvider.findCover(
      item,
      async () => null,
      async () => null,
      async () => null,
      async () => {
        lookups++;
        return "isbn-cover";
      },
    );

    assert.equal(lookups, 0);
    assert.match(cover!, /^data:image\/svg\+xml;charset=utf-8,/);
  });

  it("prefers a local attachment over an ISBN cover", async function () {
    const item = parent(
      [attachment(1, "application/pdf", "book.pdf")],
      "978-3-570-40293-1",
    );
    let isbnLookups = 0;
    setPref("fetchISBNCover", true);

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => null,
        async () => "pdf-cover",
        async () => null,
        async () => {
          isbnLookups++;
          return "isbn-cover";
        },
      ),
      "pdf-cover",
    );
    assert.equal(isbnLookups, 0);
  });

  it("creates a stable visual placeholder when no attachment has a cover", async function () {
    Zotero.Items.get = (() => []) as typeof originalGet;
    const item = {
      id: 41,
      firstCreator: "Ada Lovelace",
      getDisplayTitle: () => "Analytical Engine Notes and Observations",
      getField: (field: string) => (field === "date" ? "1843-01-01" : ""),
      isFileAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [],
      getBestAttachments: async () => [],
    } as unknown as Zotero.Item;

    const first = await CoverProvider.findCover(item);
    const second = await CoverProvider.findCover(item);

    assert.equal(first, second);
    assert.match(first!, /^data:image\/svg\+xml;charset=utf-8,/);
    const svg = new (Zotero.getMainWindow()!.DOMParser)().parseFromString(
      decodeURIComponent(first!.split(",")[1]),
      "image/svg+xml",
    );
    assert.equal(svg.documentElement.getAttribute("viewBox"), "0 0 420 594");
    assert.equal(
      Array.from(
        svg.querySelectorAll("tspan"),
        (line) => line.textContent,
      ).join(" "),
      "Analytical Engine Notes and Observations",
    );
    assert.include(svg.documentElement.textContent, "Ada Lovelace");
    assert.equal(
      svg.querySelector('[data-metadata="year"]')?.textContent,
      "1843",
    );
    assert.notExists(svg.querySelector("parsererror"));
  });

  it("does not publish a cover from an invalidated lookup", async function () {
    const originalFindCover = CoverProvider.findCoverResult;
    let resolveFirst!: (cover: { uri: string; source: "online" }) => void;
    let resolveSecond!: (cover: { uri: string; source: "attachment" }) => void;
    let calls = 0;
    CoverProvider.findCoverResult = (() =>
      new Promise((resolve) => {
        calls++;
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      })) as typeof CoverProvider.findCoverResult;
    const item = { id: 99 } as Zotero.Item;

    CoverProvider.cacheCover(item);
    const first = CoverProvider.getCover(item.id);
    CoverProvider.invalidate(item.id);
    CoverProvider.cacheCover(item);
    const second = CoverProvider.getCover(item.id);

    resolveFirst({ uri: "stale-cover", source: "online" });
    resolveSecond({ uri: "fresh-cover", source: "attachment" });
    assert.isNull(await first);
    assert.equal(await second, "fresh-cover");
    assert.deepEqual(await CoverProvider.getCoverResult(item.id), {
      uri: "fresh-cover",
      source: "attachment",
    });
    CoverProvider.findCoverResult = originalFindCover;
  });

  it("publishes a normal lookup once and deduplicates it", async function () {
    const originalFindCover = CoverProvider.findCoverResult;
    let resolveCover!: (cover: { uri: string; source: "online" }) => void;
    let calls = 0;
    CoverProvider.findCoverResult = (() => {
      calls++;
      return new Promise((resolve) => {
        resolveCover = resolve;
      });
    }) as typeof CoverProvider.findCoverResult;
    const item = { id: 100 } as Zotero.Item;

    try {
      CoverProvider.cacheCover(item);
      CoverProvider.cacheCover(item);
      const result = CoverProvider.getCover(item.id);
      resolveCover({ uri: "cover", source: "online" });
      assert.equal(await result, "cover");
      assert.equal(calls, 1);
      assert.equal(await CoverProvider.getCover(item.id), "cover");
      assert.deepEqual(await CoverProvider.getCoverResult(item.id), {
        uri: "cover",
        source: "online",
      });
    } finally {
      CoverProvider.findCoverResult = originalFindCover;
    }
  });

  it("rejects an old lookup when metadata and lookup settings change together", async function () {
    const originalFindCover = CoverProvider.findCoverResult;
    const originalMetadataPref = getPref("fetchMetadataCover");
    const state = { title: "Before" };
    const item = {
      id: 103,
      getDisplayTitle: () => state.title,
      getField: () => "",
    } as unknown as Zotero.Item;
    let resolveOld!: (cover: { uri: string; source: "online" }) => void;
    let calls = 0;
    CoverProvider.findCoverResult = (() => {
      calls++;
      return calls === 1
        ? new Promise((resolve) => (resolveOld = resolve))
        : Promise.resolve({ uri: "new-cover", source: "attachment" });
    }) as typeof CoverProvider.findCoverResult;
    try {
      CoverProvider.cacheCover(item);
      const old = CoverProvider.getCover(item.id);
      state.title = "After";
      setPref("fetchMetadataCover", !originalMetadataPref);
      CoverProvider.cacheCover(item);
      resolveOld({ uri: "old-cover", source: "online" });
      assert.isNull(await old);
      assert.equal(await CoverProvider.getCover(item.id), "new-cover");
    } finally {
      CoverProvider.findCoverResult = originalFindCover;
      setPref("fetchMetadataCover", originalMetadataPref);
    }
  });

  it("refreshes a cached cover when ISBN fetching changes", async function () {
    const originalFindCover = CoverProvider.findCoverResult;
    let calls = 0;
    CoverProvider.findCoverResult = (async () => {
      calls++;
      return getPref("fetchISBNCover")
        ? { uri: "isbn-cover", source: "online" }
        : { uri: "placeholder", source: "placeholder" };
    }) as typeof CoverProvider.findCoverResult;
    const item = { id: 102 } as Zotero.Item;

    try {
      CoverProvider.cacheCover(item);
      assert.equal(await CoverProvider.getCover(item.id), "placeholder");

      setPref("fetchISBNCover", true);
      CoverProvider.cacheCover(item);
      assert.equal(await CoverProvider.getCover(item.id), "isbn-cover");
      assert.equal(calls, 2);
    } finally {
      CoverProvider.findCoverResult = originalFindCover;
    }
  });

  it("invalidates a cached regular parent for an attachment notification", async function () {
    let observer: _ZoteroTypes.Notifier.Notify | undefined;
    Zotero.Notifier.registerObserver = ((ref) => {
      observer = ref.notify;
      return "cover-test-notifier";
    }) as typeof Zotero.Notifier.registerObserver;
    const attachment = {
      id: 101,
      parentItemID: 42,
      attachmentContentType: "application/pdf",
      attachmentReaderType: "pdf",
      isFileAttachment: () => true,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    Zotero.Items.get = ((id: number) =>
      id === attachment.id ? attachment : false) as typeof originalGet;
    const originalFindCover = CoverProvider.findCoverResult;
    CoverProvider.findCoverResult = async () => ({
      uri: "old-cover",
      source: "online",
    });

    try {
      CoverProvider.cacheCover({ id: 42 } as Zotero.Item);
      assert.equal(await CoverProvider.getCover(42), "old-cover");
      CoverProvider.registerNotifier();
      observer!("modify", "item", [attachment.id], {});
      assert.isNull(await CoverProvider.getCover(42));
    } finally {
      CoverProvider.unregisterNotifier();
      CoverProvider.findCoverResult = originalFindCover;
    }
  });

  it("refreshes only changed cover metadata, not tags", async function () {
    let observer: _ZoteroTypes.Notifier.Notify | undefined;
    Zotero.Notifier.registerObserver = ((ref) => {
      observer = ref.notify;
      return "metadata-test-notifier";
    }) as typeof Zotero.Notifier.registerObserver;
    const originalFindCover = CoverProvider.findCoverResult;
    const state = {
      title: "Before",
      creator: "Old Author",
      date: "2020",
      isbn: "",
    };
    const item = {
      id: 120,
      itemType: "book",
      firstCreator: state.creator,
      getDisplayTitle: () => state.title,
      getField: (field: string) =>
        field === "title"
          ? state.title
          : field === "date"
            ? state.date
            : state.isbn,
      getCreatorsJSON: () => [
        { lastName: state.creator, creatorType: "author" },
      ],
      isRegularItem: () => true,
      getAttachments: () => [],
    } as unknown as Zotero.Item;
    Zotero.Items.get = ((id: number) =>
      id === item.id ? item : false) as typeof originalGet;
    const changes: number[] = [];
    const stop = CoverProvider.onCoverChanged((id) => changes.push(id));
    let lookups = 0;
    CoverProvider.findCoverResult = (async () => {
      lookups++;
      return { uri: `cover-${lookups}`, source: "placeholder" };
    }) as typeof CoverProvider.findCoverResult;
    try {
      CoverProvider.registerNotifier();
      CoverProvider.cacheCover(item);
      assert.equal(await CoverProvider.getCover(item.id), "cover-1");
      observer!("modify", "item", [item.id], {
        [item.id]: { changed: { tags: true } },
      });
      CoverProvider.cacheCover(item);
      assert.equal(await CoverProvider.getCover(item.id), "cover-1");
      for (const field of [
        "title",
        "creator",
        "date",
        "isbn",
        "type",
      ] as const) {
        if (field === "title") state.title = "After";
        if (field === "creator") {
          state.creator = "New Author";
          Object.assign(item, { firstCreator: state.creator });
        }
        if (field === "date") state.date = "2024";
        if (field === "isbn") state.isbn = "0385472579";
        if (field === "type")
          Object.assign(item, { itemType: "journalArticle" });
        observer!("modify", "item", [item.id], {});
        assert.isNull(await CoverProvider.getCover(item.id));
        CoverProvider.cacheCover(item);
        assert.equal(await CoverProvider.getCover(item.id), `cover-${lookups}`);
      }
      assert.equal(changes.length, 5);
      assert.equal(lookups, 6);
    } finally {
      stop();
      CoverProvider.unregisterNotifier();
      CoverProvider.findCoverResult = originalFindCover;
    }
  });
});
