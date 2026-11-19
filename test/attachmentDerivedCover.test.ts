import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { createItems, patch, track } from "./helpers/gridFixture";
import {
  assertCover,
  attach,
  findCover,
  useCoverProvider,
  TALL,
  WIDE,
} from "./helpers/coverLookup";
import {
  epubBytes,
  EPUBOptions,
  imageBytes,
  imageSize,
  pdfBytes,
  scratchFile,
} from "./helpers/testEnvironment";

const PORTRAIT_PAGE = { width: 200, height: 300 };
const LANDSCAPE_PAGE = { width: 300, height: 200 };

function png(ratio: number): Uint8Array {
  return imageBytes(60 * ratio, 60);
}

async function book(): Promise<Zotero.Item> {
  const [item] = await createItems(1);
  return item;
}

async function attachEPUB(
  options: EPUBOptions,
  parent?: Zotero.Item,
): Promise<Zotero.Item> {
  return attach(
    await scratchFile("book.epub", epubBytes(options)),
    "application/epub+zip",
    { parent },
  );
}

async function attachPDF(
  page: { width: number; height: number },
  parent?: Zotero.Item,
): Promise<Zotero.Item> {
  return attach(
    await scratchFile("book.pdf", pdfBytes(page)),
    "application/pdf",
    { parent },
  );
}

/** The current cover as the provider caches it for display. */
function displayedCover(item: Zotero.Item) {
  CoverProvider.cacheCover(item);
  return CoverProvider.getCoverResult(item.id);
}

/** EPUBs whose cover image is found, by how it is referenced. */
const foundReferences: [string, () => EPUBOptions][] = [
  [
    "relative to the package document, percent-encoded, with query and fragment",
    () => ({
      manifest:
        '<item properties="cover-image" href="../Images/cover%20image.png?download=1#cover"/>',
      entries: { "Images/cover image.png": png(TALL) },
    }),
  ],
  [
    "in a package directory named with percent, query and fragment characters",
    () => ({
      packagePath: "OPS%20#?/package.opf",
      manifest: '<item properties="cover-image" href="cover.png"/>',
      entries: { "OPS%20#?/cover.png": png(TALL) },
    }),
  ],
  [
    "decoded exactly once",
    () => ({
      manifest: '<item properties="cover-image" href="cover%2520%23%3F.png"/>',
      entries: {
        "OPS/cover%20#?.png": png(TALL),
        "OPS/cover #?.png": png(WIDE),
      },
    }),
  ],
  [
    "starting at the archive root",
    () => ({
      manifest: '<item properties="cover-image" href="/Images/cover.png"/>',
      entries: {
        "Images/cover.png": png(TALL),
        "OPS/Images/cover.png": png(WIDE),
      },
    }),
  ],
];

/** An EPUB declaring the cover image at `href`. */
function coverAt(href: string): EPUBOptions {
  return {
    manifest: `<item properties="cover-image" href="${href}"/>`,
    // Images where a lenient reader might look for the cover.
    entries: {
      "OPS/cover.png": png(TALL),
      "OPS/images/cover.png": png(TALL),
      "OPS/cover%ZZ.png": png(TALL),
    },
  };
}

/** EPUBs whose declared cover is not used, by where it would come from. */
const rejectedSources: [string, () => EPUBOptions][] = [
  ["an https reference", () => coverAt("https://example.invalid/cover.png")],
  [
    "a protocol-relative reference",
    () => coverAt("//example.invalid/cover.png"),
  ],
  ["a data URI", () => coverAt("data:image/png,abc")],
  ["a reference escaping the archive", () => coverAt("../../cover.png")],
  [
    "an encoded reference escaping the archive",
    () => coverAt("%2e%2e/%2e%2e/cover.png"),
  ],
  [
    "a reference with an encoded separator",
    () => coverAt("images%2fcover.png"),
  ],
  ["a malformed percent-encoding", () => coverAt("cover%ZZ.png")],
  [
    "a package document outside the archive",
    () => ({
      entries: {
        "META-INF/container.xml": `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="../package.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>`,
      },
    }),
  ],
  [
    "a malformed container",
    () => ({ entries: { "META-INF/container.xml": "<broken>" } }),
  ],
  [
    "a malformed package document",
    () => ({ entries: { "OPS/package.opf": "<broken>" } }),
  ],
  [
    "a declaration outside the manifest and metadata",
    () => ({
      manifest: "",
      metadata:
        '<extension><item properties="cover-image" href="cover.png"/></extension>',
      entries: { "OPS/cover.png": png(TALL) },
    }),
  ],
];

describe("attachment-derived cover", function () {
  this.timeout(20000);

  beforeEach(useCoverProvider);

  const sources: [
    string,
    (parent?: Zotero.Item) => Promise<Zotero.Item>,
    number,
  ][] = [
    [
      "an image",
      async (parent) =>
        attach(await scratchFile("cover.png", png(TALL)), "image/png", {
          parent,
        }),
      TALL,
    ],
    // The EPUB's default cover image is 40 by 60 pixels.
    ["an EPUB", (parent) => attachEPUB({}, parent), 40 / 60],
    ["a PDF", (parent) => attachPDF(LANDSCAPE_PAGE, parent), 3 / 2],
  ];
  for (const [source, add, ratio] of sources) {
    it(`comes from ${source} attachment of an item`, async function () {
      const item = await book();
      await add(item);
      await assertCover(await findCover(item), "attachment", ratio);
    });

    it(`comes from ${source} attachment standing alone`, async function () {
      await assertCover(await findCover(await add()), "attachment", ratio);
    });
  }

  describe("from an image", function () {
    for (const contentType of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/tiff",
    ])
      it(`is taken from a ${contentType} attachment`, async function () {
        const item = await book();
        await attach(await scratchFile("cover", png(TALL)), contentType, {
          parent: item,
        });
        await assertCover(await findCover(item), "attachment");
      });

    it("is not taken from an SVG attachment", async function () {
      const item = await book();
      await attach(
        await scratchFile(
          "cover.svg",
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>',
        ),
        "image/svg+xml",
        { parent: item },
      );
      await assertCover(await findCover(item), "placeholder");
    });

    it("is not taken from an image linked by URL", async function () {
      const item = await book();
      track(
        await Zotero.Attachments.linkFromURL({
          url: "https://example.invalid/cover.png",
          parentItemID: item.id,
          contentType: "image/png",
          title: "Cover",
        }),
      );
      await assertCover(await findCover(item), "placeholder");
    });
  });

  describe("from an EPUB", function () {
    async function epubCover(options: EPUBOptions) {
      return findCover(await attachEPUB(options));
    }

    it("is the image declared as EPUB 3 cover image rather than the EPUB 2 cover", async function () {
      await assertCover(
        await epubCover({
          manifest: `<item id="old" href="old.png" media-type="image/png"/>
            <item id="new" properties="nav cover-image scripted" href="new.png" media-type="image/png"/>`,
          metadata: '<meta name="cover" content="old"/>',
          entries: { "OPS/old.png": png(WIDE), "OPS/new.png": png(TALL) },
        }),
        "attachment",
        TALL,
      );
    });

    it("is the manifest item named as EPUB 2 cover", async function () {
      await assertCover(
        await epubCover({
          manifest: `<item id="other" href="other.png" media-type="image/png"/>
            <item id="cover" href="cover.png" media-type="image/png"/>`,
          metadata: '<meta name="cover" content="cover"/>',
          entries: { "OPS/other.png": png(WIDE), "OPS/cover.png": png(TALL) },
        }),
        "attachment",
        TALL,
      );
    });

    describe("is found at a reference", function () {
      for (const [reference, options] of foundReferences)
        it(reference, async function () {
          await assertCover(await epubCover(options()), "attachment", TALL);
        });
    });

    describe("is not taken from", function () {
      for (const [source, options] of rejectedSources)
        it(source, async function () {
          await assertCover(await epubCover(options()), "placeholder");
        });
    });
  });

  describe("from a PDF", function () {
    it("shows the complete first page, sharp enough for a 2x Item Pane preview", async function () {
      const cover = await findCover(await attachPDF(PORTRAIT_PAGE));
      await assertCover(cover, "attachment", 2 / 3);
      assert.isAtLeast((await imageSize(cover.uri)).width, 1200);
    });

    it("is rendered by older Zotero versions without the reader module", async function () {
      const win = Zotero.getMainWindow()!;
      patch(win, "eval", (() => {
        throw new Error("Reader ES module unavailable");
      }) as typeof win.eval);
      const cover = await findCover(await attachPDF(PORTRAIT_PAGE));
      await assertCover(cover, "attachment", 2 / 3);
      assert.isAtLeast((await imageSize(cover.uri)).width, 1200);
    });

    describe("is kept on disk", function () {
      let item: Zotero.Item;
      let attachment: Zotero.Item;

      beforeEach(async function () {
        item = await book();
        attachment = await attachPDF(PORTRAIT_PAGE, item);
        await assertCover(await displayedCover(item), "attachment", 2 / 3);
        // Change the page without Zotero noticing, so that a cover rendered
        // afresh can be told apart from the one on disk.
        await IOUtils.write(
          (await attachment.getFilePathAsync()) as string,
          pdfBytes(LANDSCAPE_PAGE),
        );
      });

      it("across sessions, until the attachment file is renamed", async function () {
        CoverProvider.clearCache();
        await assertCover(await findCover(item), "attachment", 2 / 3);
        await attachment.renameAttachmentFile("renamed.pdf");
        await assertCover(await findCover(item), "attachment", 3 / 2);
      });

      it("when only the parent item's metadata changes", async function () {
        item.setField("title", `${item.getField("title")} (revised)`);
        await item.saveTx();
        await assertCover(await displayedCover(item), "attachment", 2 / 3);
      });
    });
  });
});
