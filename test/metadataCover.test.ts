import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import { registerCoverColumn } from "../src/modules/coverColumn";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import { GridView } from "../src/modules/gridView";
import { clearPref, getPref, setPref } from "../src/utils/prefs";

const metadataPref = "fetchMetadataCover";
const editionKey = "OL12345M";
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
  let searchResultsForURL: ((url: string) => object) | undefined;
  let coverStatus: number;
  let recordedCoverStatus: number;

  function book(
    options: {
      type?: string;
      title?: string;
      creators?: string[];
      creatorData?: Array<{
        firstName?: string;
        lastName?: string;
        name?: string;
        creatorType: "author" | "translator";
      }>;
      displayCreator?: string;
      isbn?: string;
      date?: string;
      attachments?: Zotero.Item[];
    } = {},
  ): Zotero.Item {
    const {
      type = "book",
      title = "The Test Book",
      creators = ["Ada Lovelace"],
      creatorData,
      displayCreator,
      isbn = "",
      date = "",
      attachments = [],
    } = options;
    Zotero.Items.get = (() => attachments) as typeof originalGet;
    return {
      id: 92109,
      itemType: type,
      firstCreator: displayCreator ?? creators[0] ?? "",
      isFileAttachment: () => false,
      isRegularItem: () => true,
      getDisplayTitle: () => title,
      getField: (field: string) =>
        field === "ISBN"
          ? isbn
          : field === "title"
            ? title
            : field === "date"
              ? date
              : "",
      getCreators: () =>
        creators.map((name) => ({
          firstName: name.split(" ")[0],
          lastName: name.split(" ").slice(1).join(" "),
          creatorType: "author",
        })),
      getCreatorsJSON: () =>
        creatorData ??
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
    for (const isbn of [recordedISBN]) {
      for (const extension of ["jpg", "missing"]) {
        await IOUtils.remove(
          PathUtils.join(directory, `${isbn}.${extension}`),
          {
            ignoreAbsent: true,
          },
        );
      }
    }
    for (const extension of ["jpg", "missing"]) {
      await IOUtils.remove(
        PathUtils.join(directory, "olid", `${editionKey}.${extension}`),
        { ignoreAbsent: true },
      );
    }
    for (const [title, author] of [
      ["The Test Book", "Lovelace, Ada"],
      ["The Test Book", "Lovelace"],
      ["The Test Book", "Arthur Conan Doyle"],
      ["The Test Book", "Doyle"],
      ["Das Vermächtnis der Drachenreiter", "Paolini, Christopher"],
      ["A Study in Scarlet", "Doyle, Sir Arthur Conan"],
      ["A Study in Scarlet", "Doyle"],
      ["Another Test Book", "Lovelace, Ada"],
      ["Another Test Book", "Lovelace"],
      ["A New Title", "Author, New"],
      ["Edited Book", "Lovelace, Ada"],
      ["The Test Book", "Author, New"],
      ["The Test Book", "Author"],
    ]) {
      const query = JSON.stringify([title, author]);
      await IOUtils.remove(
        PathUtils.join(
          directory,
          "olid",
          "search",
          `${Zotero.Utilities.Internal.sha1(query)}.json`,
        ),
        { ignoreAbsent: true },
      );
      const url = `https://openlibrary.org/search.json?q=title:${encodeURIComponent(title)}%20author:${encodeURIComponent(author)}`;
      await IOUtils.remove(
        PathUtils.join(
          directory,
          "olid",
          "search",
          `${Zotero.Utilities.Internal.sha1(url)}.json`,
        ),
        { ignoreAbsent: true },
      );
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
          cover_edition_key: editionKey,
        },
      ],
    };
    searchResultsForURL = undefined;
    coverStatus = 200;
    recordedCoverStatus = 200;
    Zotero.HTTP.request = (async (
      method: string,
      url: string,
      options: unknown,
    ) => {
      const isSearch = url.includes("openlibrary.org/search.json");
      const isISBNCover = url.includes("covers.openlibrary.org/b/isbn/");
      const isMetadataCover = url.includes("covers.openlibrary.org/b/olid/");
      if (!isSearch && !isISBNCover && !isMetadataCover)
        return originalRequest.call(Zotero.HTTP, method, url, options as never);
      requests.push(url);
      return {
        status:
          isISBNCover || isMetadataCover
            ? url.includes(recordedISBN)
              ? recordedCoverStatus
              : coverStatus
            : 200,
        response: (isISBNCover || isMetadataCover
          ? jpeg
          : new TextEncoder().encode(
              JSON.stringify(searchResultsForURL?.(url) ?? searchResult),
            )
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

  it("uses metadata with ISBN fetching off and leaves the item unchanged", async function () {
    const item = book({ isbn: recordedISBN });
    const originalField = item.getField("ISBN");
    placeholder(await CoverProvider.findCover(item));
    setPref(metadataPref, true);
    const cover = await CoverProvider.findCover(item);
    assert.include(cover!, `${editionKey}.jpg`);
    assert.isTrue(requests.some((url) => url.includes("search.json")));
    assert.isFalse(requests.some((url) => url.includes("/b/isbn/")));
    assert.isTrue(
      requests.some((url) => url.includes(`/olid/${editionKey}-L.jpg`)),
    );
    assert.strictEqual(item.getField("ISBN"), originalField);
    assert.deepEqual(item.getAttachments(), []);
  });

  it("does not search metadata when only ISBN fetching is enabled", async function () {
    setPref("fetchISBNCover", true);
    placeholder(await CoverProvider.findCover(book()));
    assert.isEmpty(requests);
  });

  it("searches using the first author's real name, not the multi-creator display label", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    const item = book({
      title: "Das Vermächtnis der Drachenreiter",
      creators: [
        "Christopher Paolini",
        "Sidharth Chaturvedi",
        "Joannis Stefanidis",
        "Christopher Paolini",
      ],
      displayCreator: "Paolini et al.",
      creatorData: [
        {
          firstName: "Christopher",
          lastName: "Paolini",
          creatorType: "author",
        },
        {
          firstName: "Sidharth",
          lastName: "Chaturvedi",
          creatorType: "author",
        },
        {
          firstName: "Joannis",
          lastName: "Stefanidis",
          creatorType: "translator",
        },
        {
          firstName: "Christopher",
          lastName: "Paolini",
          creatorType: "author",
        },
      ],
    });

    await CoverProvider.findCover(item);
    const searchURL = requests.find((url) => url.includes("/search.json"));
    assert.exists(searchURL);
    assert.include(searchURL!, "author:Paolini%2C%20Christopher");
    assert.notInclude(searchURL!, "et%20al");
  });

  it("retries with the first author's surname when a title makes their full name too restrictive", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    searchResultsForURL = (url) =>
      url.includes("author:Doyle%2C%20Sir%20Arthur%20Conan")
        ? { docs: [] }
        : searchResult;
    const item = book({
      title: "A Study in Scarlet",
      creators: ["Sir Arthur Conan Doyle"],
      creatorData: [
        {
          firstName: "Sir Arthur Conan",
          lastName: "Doyle",
          creatorType: "author",
        },
      ],
    });

    assert.include((await CoverProvider.findCover(item))!, `${editionKey}.jpg`);
    assert.deepEqual(
      requests
        .filter((url) => url.includes("/search.json"))
        .map((url) => decodeURIComponent(url.split("author:")[1])),
      ["Doyle, Sir Arthur Conan", "Doyle"],
    );
  });

  it("retries the final name of a single-field author", async function () {
    setPref(metadataPref, true);
    searchResultsForURL = (url) =>
      url.includes("author:Arthur%20Conan%20Doyle")
        ? { docs: [] }
        : searchResult;
    const item = book({
      creatorData: [{ name: "Arthur Conan Doyle", creatorType: "author" }],
    });

    assert.include((await CoverProvider.findCover(item))!, `${editionKey}.jpg`);
    assert.deepEqual(
      requests
        .filter((url) => url.includes("/search.json"))
        .map((url) => decodeURIComponent(url.split("author:")[1])),
      ["Arthur Conan Doyle", "Doyle"],
    );
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
    assert.include((await CoverProvider.findCover(item))!, `${editionKey}.jpg`);
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

  it("ignores work-level ISBNs without a usable cover edition, then shows a placeholder", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    searchResult = {
      docs: [{ isbn: [recordedISBN], cover_edition_key: "../invalid" }],
    };
    placeholder(await CoverProvider.findCover(book()));
    assert.isTrue(requests.some((url) => url.includes("/search.json")));
    assert.isFalse(requests.some((url) => url.includes("/olid/")));
    assert.isFalse(requests.some((url) => url.includes("/isbn/")));

    requests.length = 0;
    searchResult = { docs: [] };
    placeholder(
      await CoverProvider.findCover(book({ title: "Another Test Book" })),
    );
    assert.isTrue(requests.some((url) => url.includes("/search.json")));
    assert.isFalse(requests.some((url) => url.includes("/isbn/")));
  });

  it("falls back to a placeholder when the matching edition has no cover", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    coverStatus = 404;
    placeholder(await CoverProvider.findCover(book()));
    assert.isTrue(requests.some((url) => url.includes(`${editionKey}-L.jpg`)));
  });

  it("falls back to a placeholder when metadata lookup fails", async function () {
    setPref("fetchISBNCover", true);
    setPref(metadataPref, true);
    placeholder(
      await CoverProvider.findCover(
        book(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("search unavailable");
        },
      ),
    );
  });

  it("refreshes cached covers when either opt-in changes", async function () {
    const item = book();
    CoverProvider.cacheCover(item);
    placeholder(await CoverProvider.getCover(item.id));
    setPref(metadataPref, true);
    CoverProvider.cacheCover(item);
    assert.include(
      (await CoverProvider.getCover(item.id))!,
      `${editionKey}.jpg`,
    );
    setPref("fetchISBNCover", true);
    CoverProvider.cacheCover(item);
    assert.include(
      (await CoverProvider.getCover(item.id))!,
      `${editionKey}.jpg`,
    );
    setPref(metadataPref, false);
    CoverProvider.cacheCover(item);
    placeholder(await CoverProvider.getCover(item.id));
    setPref("fetchISBNCover", false);
    CoverProvider.cacheCover(item);
    placeholder(await CoverProvider.getCover(item.id));
  });

  it("replaces a changed placeholder and then uses an edited ISBN", async function () {
    const first = book({ title: "Original", date: "2020" });
    CoverProvider.cacheCover(first);
    const initial = await CoverProvider.getCover(first.id);
    assert.include(decodeURIComponent(initial!), "Original");
    assert.include(decodeURIComponent(initial!), ">2020</text>");

    const edited = book({
      title: "Revised",
      creators: ["New Author"],
      date: "2024",
    });
    CoverProvider.cacheCover(edited);
    const changed = await CoverProvider.getCover(edited.id);
    assert.include(decodeURIComponent(changed!), "Revised");
    assert.include(decodeURIComponent(changed!), "New Author");
    assert.include(decodeURIComponent(changed!), ">2024</text>");
    assert.notEqual(changed, initial);
    assert.isEmpty(requests);

    setPref("fetchISBNCover", true);
    const withISBN = book({
      title: "Revised",
      creators: ["New Author"],
      isbn: recordedISBN,
    });
    CoverProvider.cacheCover(withISBN);
    assert.include(
      (await CoverProvider.getCover(withISBN.id))!,
      `${recordedISBN}.jpg`,
    );
  });

  it("reconsiders metadata lookup when an item becomes a book", async function () {
    setPref(metadataPref, true);
    const section = book({ type: "bookSection" });
    CoverProvider.cacheCover(section);
    placeholder(await CoverProvider.getCover(section.id));
    assert.isEmpty(requests);

    const converted = book();
    CoverProvider.cacheCover(converted);
    assert.include(
      (await CoverProvider.getCover(converted.id))!,
      `${editionKey}.jpg`,
    );
    assert.isTrue(requests.some((url) => url.includes("search.json")));
  });

  it("resolves changed title and author with new keys while retaining shared results", async function () {
    setPref(metadataPref, true);
    const original = book();
    CoverProvider.cacheCover(original);
    assert.include(
      (await CoverProvider.getCover(original.id))!,
      `${editionKey}.jpg`,
    );

    const editedTitle = book({ title: "Edited Book" });
    CoverProvider.cacheCover(editedTitle);
    assert.include(
      (await CoverProvider.getCover(original.id))!,
      `${editionKey}.jpg`,
    );

    const editedAuthor = book({ creators: ["New Author"] });
    CoverProvider.cacheCover(editedAuthor);
    assert.include(
      (await CoverProvider.getCover(original.id))!,
      `${editionKey}.jpg`,
    );

    CoverProvider.cacheCover(original);
    assert.include(
      (await CoverProvider.getCover(original.id))!,
      `${editionKey}.jpg`,
    );
    assert.equal(
      requests.filter((url) => url.includes("search.json")).length,
      3,
    );
  });

  it("redraws the Cover column on a cover-setting change even with the grid active", function () {
    const originalGridPref = getPref("enableGridView");
    let rowRefreshes = 0;
    let gridRefreshes = 0;
    const view = {
      tree: { refreshRows: () => rowRefreshes++ },
      scheduleSync: () => gridRefreshes++,
    } as unknown as GridView;
    try {
      setPref("enableGridView", true);
      GridView.prototype.refreshCovers.call(view);
      assert.equal(rowRefreshes, 1);
      assert.equal(gridRefreshes, 1);

      setPref("enableGridView", false);
      GridView.prototype.refreshCovers.call(view);
      assert.equal(rowRefreshes, 2);
      assert.equal(gridRefreshes, 1);
    } finally {
      setPref("enableGridView", originalGridPref);
    }
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
      renderer.setItems([item], { showCreators: true });
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
      assert.include(tile.querySelector("img")!.src, `${editionKey}.jpg`);
      assert.equal(
        cell.querySelector("img")!.src,
        tile.querySelector("img")!.src,
      );
      assert.equal(
        requests.filter((url) => url.includes("search.json")).length,
        1,
      );
      setPref(metadataPref, false);
      const edited = book({ title: "A New Title", creators: ["New Author"] });
      Zotero.Items.get = ((id: number | number[]) =>
        id === edited.id ? edited : []) as typeof originalGet;
      CoverProvider.invalidate(edited.id, { discardPDF: false });
      renderer.refreshCover(edited.id);
      const updatedTile = host.querySelector<HTMLElement>(".grid-view-item")!;
      assert.equal(
        updatedTile.querySelector(".grid-view-title")!.textContent,
        "A New Title",
      );
      nearViewport?.(
        [
          {
            isIntersecting: true,
            target: updatedTile,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      const updatedData = column!.dataProvider(edited, "cover");
      const updatedCell = column!.renderCell(
        0,
        updatedData,
        { className: "cover" },
        false,
        win.document,
      );
      await CoverProvider.getCover(edited.id);
      await Zotero.Promise.delay(0);
      const gridCover = updatedTile.querySelector("img")!.src;
      assert.include(decodeURIComponent(gridCover), "A New Title");
      assert.equal(updatedCell.querySelector("img")!.src, gridCover);
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
