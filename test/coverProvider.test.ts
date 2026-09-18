import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";

describe("Cover provider", function () {
  let originalGet: typeof Zotero.Items.get;
  let originalRegister: typeof Zotero.Notifier.registerObserver;

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

  function parent(attachments: Zotero.Item[]): Zotero.Item {
    Zotero.Items.get = (() => attachments) as typeof originalGet;
    return {
      isFileAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => attachments.map(({ id }) => id),
    } as unknown as Zotero.Item;
  }

  beforeEach(function () {
    originalGet = Zotero.Items.get;
    originalRegister = Zotero.Notifier.registerObserver;
  });

  afterEach(function () {
    Zotero.Items.get = originalGet;
    Zotero.Notifier.registerObserver = originalRegister;
    CoverProvider.clearCache();
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
        async (attachment) => `cover:${await attachment.getFilePathAsync()}`,
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
        async (attachment) => `cover:${await attachment.getFilePathAsync()}`,
      ),
      "cover:cover.webp",
    );
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
    const originalFindCover = CoverProvider.findCover;
    let resolveFirst!: (cover: string | null) => void;
    let resolveSecond!: (cover: string | null) => void;
    let calls = 0;
    CoverProvider.findCover = (() =>
      new Promise<string | null>((resolve) => {
        calls++;
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      })) as typeof CoverProvider.findCover;
    const item = { id: 99 } as Zotero.Item;

    CoverProvider.cacheCover(item);
    const first = CoverProvider.getCover(item.id);
    CoverProvider.invalidate(item.id);
    CoverProvider.cacheCover(item);
    const second = CoverProvider.getCover(item.id);

    resolveFirst("stale-cover");
    resolveSecond("fresh-cover");
    assert.isNull(await first);
    assert.equal(await second, "fresh-cover");
    CoverProvider.findCover = originalFindCover;
  });

  it("publishes a normal lookup once and deduplicates it", async function () {
    const originalFindCover = CoverProvider.findCover;
    let resolveCover!: (cover: string | null) => void;
    let calls = 0;
    CoverProvider.findCover = (() => {
      calls++;
      return new Promise<string | null>((resolve) => {
        resolveCover = resolve;
      });
    }) as typeof CoverProvider.findCover;
    const item = { id: 100 } as Zotero.Item;

    try {
      CoverProvider.cacheCover(item);
      CoverProvider.cacheCover(item);
      const result = CoverProvider.getCover(item.id);
      resolveCover("cover");
      assert.equal(await result, "cover");
      assert.equal(calls, 1);
      assert.equal(await CoverProvider.getCover(item.id), "cover");
    } finally {
      CoverProvider.findCover = originalFindCover;
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
    const originalFindCover = CoverProvider.findCover;
    CoverProvider.findCover = (async () =>
      "old-cover") as typeof CoverProvider.findCover;

    try {
      CoverProvider.cacheCover({ id: 42 } as Zotero.Item);
      assert.equal(await CoverProvider.getCover(42), "old-cover");
      CoverProvider.registerNotifier();
      observer!("modify", "item", [attachment.id], {});
      assert.isNull(await CoverProvider.getCover(42));
    } finally {
      CoverProvider.unregisterNotifier();
      CoverProvider.findCover = originalFindCover;
    }
  });
});
