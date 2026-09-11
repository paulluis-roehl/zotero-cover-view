import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";

describe("Cover provider", function () {
  let originalGet: typeof Zotero.Items.get;

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
  });

  afterEach(function () {
    Zotero.Items.get = originalGet;
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
});
