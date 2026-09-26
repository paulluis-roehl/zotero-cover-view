import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import { registerCoverColumn } from "../src/modules/coverColumn";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import { clearPref, getPref, setPref } from "../src/utils/prefs";

// The preference is deliberately accessed by name until the feature adds it to
// the generated preference types. These tests must compile before implementation.
const metadataPref = "fetchMetadataCover" as "fetchISBNCover";
const editionISBN = "9780385533225";
const recordedISBN = "0385472579";
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("opt-in metadata cover lookup", function () {
  let originalGet: typeof Zotero.Items.get;
  let originalRequest: typeof Zotero.HTTP.request;
  let originalISBNPref: boolean;
  let originalMetadataPref: boolean | undefined;
  let toolkitDescriptor: PropertyDescriptor | undefined;
  const requests: string[] = [];
  let searchResult: object;
  let editionResult: object;
  let coverStatus: number;
  let recordedCoverStatus: number;

  function book(
    options: {
      type?: string;
      title?: string;
      creators?: string[];
      isbn?: string;
      attachments?: Zotero.Item[];
    } = {},
  ): Zotero.Item {
    const {
      type = "book",
      title = "The Test Book",
      creators = ["Ada Lovelace"],
      isbn = "",
      attachments = [],
    } = options;
    Zotero.Items.get = (() => attachments) as typeof originalGet;
    return {
      id: 92109,
      firstCreator: creators[0] ?? "",
      isFileAttachment: () => false,
      isRegularItem: () => true,
      getItemType: () => type,
      getDisplayTitle: () => title,
      getField: (field: string) =>
        field === "ISBN" ? isbn : field === "title" ? title : "",
      getCreators: () =>
        creators.map((name) => ({
          firstName: name.split(" ")[0],
          lastName: name.split(" ").slice(1).join(" "),
          creatorType: "author",
        })),
      getAttachments: () => attachments.map(({ id }) => id),
      setField: () => {
        throw new Error("Cover lookup must not edit the item");
      },
      saveTx: () => {
        throw new Error("Cover lookup must not save the item");
      },
    } as unknown as Zotero.Item;
  }

  function attachment(type: string): Zotero.Item {
    return {
      id: 92110,
      attachmentContentType: type,
      attachmentReaderType: type === "application/pdf" ? "pdf" : "epub",
      isFileAttachment: () => true,
      isRegularItem: () => false,
      getFilePathAsync: async () => "local-cover.pdf",
    } as unknown as Zotero.Item;
  }

  async function clearCoverCache(): Promise<void> {
    const directory = PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      "open-library",
    );
    for (const isbn of [editionISBN, recordedISBN]) {
      for (const extension of ["jpg", "missing"]) {
        await IOUtils.remove(
          PathUtils.join(directory, `${isbn}.${extension}`),
          {
            ignoreAbsent: true,
          },
        );
      }
    }
  }

  const placeholder = (cover: string | null) =>
    assert.match(cover!, /^data:image\/svg\+xml;charset=utf-8,/);

  beforeEach(async function () {
    originalGet = Zotero.Items.get;
    originalRequest = Zotero.HTTP.request;
    originalISBNPref = getPref("fetchISBNCover");
    originalMetadataPref = getPref(metadataPref);
    toolkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ztoolkit");
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: new BasicTool(),
    });
    setPref("fetchISBNCover", false);
    setPref(metadataPref, false);
    CoverProvider.clearCache();
    await clearCoverCache();
    requests.length = 0;
    searchResult = {
      docs: [
        {
          key: "/works/OL1W",
          title: "The Test Book",
          author_name: ["Ada Lovelace"],
          isbn: [recordedISBN],
          edition_key: ["OL1M"],
        },
      ],
    };
    editionResult = {
      key: "/books/OL1M",
      title: "The Test Book",
      isbn_13: [editionISBN],
    };
    coverStatus = 200;
    recordedCoverStatus = 200;
    Zotero.HTTP.request = (async (
      method: string,
      url: string,
      options: unknown,
    ) => {
      const isSearch = url.includes("openlibrary.org/search.json");
      const isEdition = url.includes("openlibrary.org/books/OL1M.json");
      const isCover = url.includes("covers.openlibrary.org/b/isbn/");
      if (!isSearch && !isEdition && !isCover)
        return originalRequest.call(Zotero.HTTP, method, url, options as never);
      requests.push(url);
      const payload = isSearch ? searchResult : editionResult;
      return {
        status: isCover
          ? url.includes(recordedISBN)
            ? recordedCoverStatus
            : coverStatus
          : 200,
        response: (isCover
          ? jpeg
          : new TextEncoder().encode(JSON.stringify(payload))
        ).buffer,
      };
    }) as typeof Zotero.HTTP.request;
  });

  afterEach(async function () {
    Zotero.Items.get = originalGet;
    Zotero.HTTP.request = originalRequest;
    setPref("fetchISBNCover", originalISBNPref);
    if (originalMetadataPref === undefined) clearPref(metadataPref);
    else setPref(metadataPref, originalMetadataPref);
    if (toolkitDescriptor)
      Object.defineProperty(globalThis, "ztoolkit", toolkitDescriptor);
    else Reflect.deleteProperty(globalThis, "ztoolkit");
    CoverProvider.clearCache();
    await clearCoverCache();
  });

  it("defaults the independent metadata setting off", function () {
    // A default pref must exist even if the user has never opened preferences.
    clearPref(metadataPref);
    assert.strictEqual(getPref(metadataPref), false);
  });

  it("requires both opt-ins and leaves the item unchanged", async function () {
    const item = book();
    const originalField = item.getField("ISBN");
    placeholder(await CoverProvider.findCover(item));
    setPref(metadataPref, true);
    placeholder(await CoverProvider.findCover(item));
    assert.isEmpty(requests);

    setPref("fetchISBNCover", true);
    const cover = await CoverProvider.findCover(item);
    assert.include(cover!, `${editionISBN}.jpg`);
    assert.isTrue(requests.some((url) => url.includes("search.json")));
    assert.isTrue(requests.some((url) => url.includes("/books/OL1M.json")));
    assert.strictEqual(item.getField("ISBN"), originalField);
    assert.deepEqual(item.getAttachments(), []);
  });

  it("keeps local covers and recorded ISBNs ahead of metadata search", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    const local = book({ attachments: [attachment("application/pdf")] });
    assert.equal(
      await CoverProvider.findCover(
        local,
        async () => null,
        async () => "pdf-cover",
      ),
      "pdf-cover",
    );
    assert.isEmpty(requests);

    const recorded = book({ isbn: recordedISBN });
    assert.include(
      (await CoverProvider.findCover(recorded))!,
      `${recordedISBN}.jpg`,
    );
    assert.isFalse(requests.some((url) => url.includes("search.json")));
  });

  it("searches after a recorded ISBN cover misses", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    recordedCoverStatus = 404;
    const item = book({ isbn: recordedISBN });
    assert.include(
      (await CoverProvider.findCover(item))!,
      `${editionISBN}.jpg`,
    );
    assert.isTrue(
      requests.some((url) => url.includes(`${recordedISBN}-L.jpg`)),
    );
    assert.isTrue(requests.some((url) => url.includes("/search.json")));
  });

  it("searches only regular books with both a title and a creator", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    for (const options of [
      { type: "bookSection" },
      { type: "journalArticle" },
      { title: "" },
      { creators: [] },
    ]) {
      placeholder(await CoverProvider.findCover(book(options)));
    }
    assert.isEmpty(requests);
  });

  it("rejects work-level ISBNs and unusable editions, then shows a placeholder", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    editionResult = { key: "/books/OL1M", isbn_13: ["9780385533226"] };
    placeholder(await CoverProvider.findCover(book()));
    assert.isTrue(requests.some((url) => url.includes("/search.json")));
    assert.isTrue(requests.some((url) => url.includes("/books/OL1M.json")));
    assert.isFalse(requests.some((url) => url.includes("/isbn/")));

    requests.length = 0;
    searchResult = { docs: [] };
    placeholder(await CoverProvider.findCover(book()));
    assert.isTrue(requests.some((url) => url.includes("/search.json")));
    assert.isFalse(requests.some((url) => url.includes("/isbn/")));
  });

  it("falls back to a placeholder when the matching edition has no cover", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    coverStatus = 404;
    placeholder(await CoverProvider.findCover(book()));
    assert.isTrue(requests.some((url) => url.includes(`${editionISBN}-L.jpg`)));
  });

  it("refreshes cached covers when either opt-in changes", async function () {
    const item = book();
    setPref("fetchISBNCover", true);
    CoverProvider.cacheCover(item);
    placeholder(await CoverProvider.getCover(item.id));
    setPref(metadataPref, true);
    CoverProvider.cacheCover(item);
    assert.include(
      (await CoverProvider.getCover(item.id))!,
      `${editionISBN}.jpg`,
    );
    setPref("fetchISBNCover", false);
    CoverProvider.cacheCover(item);
    placeholder(await CoverProvider.getCover(item.id));
  });

  it("uses the same resolved cover in the grid and Cover column without eager grid requests", async function () {
    const win = Zotero.getMainWindow()!;
    const originalRegister = Zotero.ItemTreeManager.registerColumns;
    const originalObserver = win.IntersectionObserver;
    const originalAddon = Object.getOwnPropertyDescriptor(globalThis, "addon");
    const item = book();
    const host = win.document.createElement("div");
    let nearViewport: IntersectionObserverCallback | undefined;
    let column:
      | {
          dataProvider: (item: Zotero.Item, dataKey: string) => string;
          renderCell: (
            index: number,
            data: string,
            column: { className: string },
            isFirstColumn: boolean,
            doc: Document,
          ) => HTMLElement;
        }
      | undefined;
    class FakeObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "200px") nearViewport = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, "addon", {
      configurable: true,
      value: Zotero.CoverView,
    });
    win.IntersectionObserver =
      FakeObserver as unknown as typeof IntersectionObserver;
    Zotero.ItemTreeManager.registerColumns = (async (options: unknown) => {
      column = options as typeof column;
    }) as typeof originalRegister;
    const renderer = new GridRenderer(host, () => {});
    try {
      setPref("fetchISBNCover", true);
      setPref(metadataPref, true);
      renderer.setItems([item], { showAuthors: true });
      assert.isEmpty(requests, "Rendering an offscreen tile must not search");
      const tile = host.querySelector<HTMLElement>(".grid-view-item")!;
      nearViewport?.(
        [{ isIntersecting: true, target: tile } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await CoverProvider.getCover(item.id);
      await registerCoverColumn();
      const data = column!.dataProvider(item, "cover");
      const cell = column!.renderCell(
        0,
        data,
        { className: "cover" },
        false,
        win.document,
      );
      await CoverProvider.getCover(item.id);
      await Zotero.Promise.delay(0);
      assert.include(tile.querySelector("img")!.src, `${editionISBN}.jpg`);
      assert.equal(
        cell.querySelector("img")!.src,
        tile.querySelector("img")!.src,
      );
      assert.equal(
        requests.filter((url) => url.includes("search.json")).length,
        1,
      );
    } finally {
      renderer.destroy();
      Zotero.ItemTreeManager.registerColumns = originalRegister;
      win.IntersectionObserver = originalObserver;
      if (originalAddon)
        Object.defineProperty(globalThis, "addon", originalAddon);
      else Reflect.deleteProperty(globalThis, "addon");
    }
  });
});
