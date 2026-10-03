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
  let toolkitDescriptor: PropertyDescriptor | undefined;

  function attachment(
    id: number,
    contentType: string,
    filePath: string,
  ): Zotero.Item {
    return {
      id,
      attachmentContentType: contentType,
      attachmentReaderType: contentType === "application/pdf" ? "pdf" : "epub",
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
      getAttachments: () => attachments.map(({ id }) => id),
      getDisplayTitle: () => "Test Book",
      getField: (field: string) => (field === "ISBN" ? isbn : ""),
    } as unknown as Zotero.Item;
  }

  beforeEach(function () {
    originalGet = Zotero.Items.get;
    originalRegister = Zotero.Notifier.registerObserver;
    originalFetchISBNCover = getPref("fetchISBNCover");
    toolkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ztoolkit");
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: new BasicTool(),
    });
    setPref("fetchISBNCover", false);
  });

  afterEach(function () {
    Zotero.Items.get = originalGet;
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

  it("prefers an image cover over EPUB and PDF covers", async function () {
    const image = attachment(1, "image/png", "cover.png");
    const item = parent([
      image,
      attachment(2, "application/epub+zip", "book.epub"),
      attachment(3, "application/pdf", "book.pdf"),
    ]);
    let epubLookups = 0;
    let pdfLookups = 0;

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => {
          epubLookups++;
          return "cover:book.epub";
        },
        async () => {
          pdfLookups++;
          return "cover:book.pdf";
        },
        async (filePath) => `cover:${filePath}`,
      ),
      "cover:cover.png",
    );
    assert.equal(epubLookups, 0);
    assert.equal(pdfLookups, 0);
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

  it("prefers an EPUB cover over a PDF cover", async function () {
    const item = parent([
      attachment(1, "application/epub+zip", "book.epub"),
      attachment(2, "application/pdf", "book.pdf"),
    ]);
    let pdfLookups = 0;

    assert.equal(
      await CoverProvider.findCover(
        item,
        async () => "cover:book.epub",
        async () => {
          pdfLookups++;
          return "cover:book.pdf";
        },
      ),
      "cover:book.epub",
    );
    assert.equal(pdfLookups, 0);
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
    } as unknown as Zotero.Item;

    const first = await CoverProvider.findCover(item);
    const second = await CoverProvider.findCover(item);

    assert.equal(first, second);
    assert.match(first!, /^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(first!.split(",")[1]);
    assert.include(svg, 'viewBox="0 0 420 594"');
    assert.include(svg, 'y="225">Analytical Engine</tspan>');
    assert.include(svg, ">Notes and</tspan>");
    assert.include(svg, ">Observations</tspan>");
    assert.include(svg, 'y="490"');
    assert.include(svg, ">Ada Lovelace</text>");
    assert.include(
      svg,
      'x="382" y="38" text-anchor="end" dominant-baseline="hanging"',
    );
    assert.include(svg, 'font-size="19" font-weight="500">1843</text>');
    assert.notInclude(svg, "&#65;");
    assert.include(svg, 'clip-path="url(#content)"');
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
