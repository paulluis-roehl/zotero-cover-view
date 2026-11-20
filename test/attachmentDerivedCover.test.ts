import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { findPDFCoverURI } from "../src/modules/covers/pdfCover";
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
  imagePaint,
  imageSize,
  pdfBytes,
  PDFOptions,
  pdfStream,
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
  options: PDFOptions,
  parent?: Zotero.Item,
): Promise<Zotero.Item> {
  return attach(
    await scratchFile("book.pdf", pdfBytes(options)),
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

    /** How the cover of a square page with the given contents paints. */
    async function paintedPage(options: PDFOptions) {
      const cover = await findCover(
        await attachPDF({ width: 100, height: 100, ...options }),
      );
      await assertCover(cover, "attachment");
      return imagePaint(cover.uri);
    }

    it("shows glyphs of a standard font the PDF does not embed", async function () {
      // A ZapfDingbats black square, filling most of the page.
      const { inked } = await paintedPage({
        content: "BT /F1 120 Tf 5 10 Td (n) Tj ET",
        objects: ["<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>"],
      });
      assert.isAbove(inked, 0.4);
    });

    // Glyphs come from a system CJK font, so this assumes one is installed.
    it("shows CJK text encoded with a predefined CMap", async function () {
      const { inked } = await paintedPage({
        width: 136,
        height: 72,
        content: "BT /F1 64 Tf 4 10 Td <65E5672C> Tj ET",
        objects: [
          "<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
          "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>",
          "<< /Type /FontDescriptor /FontName /MS-Mincho /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 700 /StemV 80 >>",
        ],
      });
      assert.isAbove(inked, 0.03);
    });

    /** A page filled with one image of the given dictionary entries and data. */
    function imagePage(dictionary: string, data: string): PDFOptions {
      return {
        content: "q 100 0 0 100 0 0 cm /Im1 Do Q",
        page: "/Resources << /XObject << /Im1 5 0 R >> >>",
        objects: [
          pdfStream(`/Type /XObject /Subtype /Image ${dictionary}`, data),
        ],
      };
    }

    it("shows a CMYK image in its colours", async function () {
      const {
        colour: [red, green, blue],
      } = await paintedPage(
        imagePage(
          "/Width 2 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /ASCIIHexDecode",
          `${"FF000000".repeat(4)}>`,
        ),
      );
      // Cyan.
      assert.isBelow(red, 100);
      assert.isAbove(green, 100);
      assert.isAbove(blue, 180);
    });

    it("shows a CCITT-compressed scanned image", async function () {
      // Eight Group 3 (K 0) rows of 8 px, each a white run of 0 then a black
      // run of 8.
      const { inked } = await paintedPage(
        imagePage(
          "/Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter [/ASCIIHexDecode /CCITTFaxDecode] /DecodeParms [null << /K 0 /Columns 8 /Rows 8 >>]",
          "3514D453514D453514D453514D45>",
        ),
      );
      assert.isAbove(inked, 0.95);
    });

    it("shows annotation appearances stored in the PDF", async function () {
      const {
        colour: [red, green, blue],
      } = await paintedPage({
        content: "",
        page: "/Annots [5 0 R]",
        objects: [
          "<< /Type /Annot /Subtype /Square /Rect [0 0 100 100] /F 4 /AP << /N 6 0 R >> >>",
          pdfStream(
            "/Type /XObject /Subtype /Form /BBox [0 0 100 100]",
            "1 0 0 rg 0 0 100 100 re f",
          ),
        ],
      });
      assert.isAbove(red, 200);
      assert.isBelow(green, 80);
      assert.isBelow(blue, 80);
    });

    describe("of a large file", function () {
      /** A PDF of 16 pages over 2 MB, its first page black, the others blue. */
      async function largePDF(): Promise<string> {
        const padding = " ".repeat(128 * 1024);
        return scratchFile(
          "large.pdf",
          pdfBytes({
            width: 100,
            height: 100,
            content: "0 0 0 rg 0 0 100 100 re f",
            morePages: Array.from(
              { length: 16 },
              () => `0 0 1 rg 0 0 100 100 re f\n${padding}`,
            ),
          }),
        );
      }

      /**
       * Pass reads of `path` through `read` until the end of the test, and
       * return the bytes read from it so far.
       */
      function watchReads(
        path: string,
        read: (
          original: typeof IOUtils.read,
          options?: ReadOptions,
        ) => Promise<Uint8Array> = (original, options) =>
          original(path, options),
      ): () => number {
        let bytes = 0;
        const original: typeof IOUtils.read = patch(
          IOUtils,
          "read",
          async (file: string, options?: ReadOptions) => {
            if (file !== path) return original(file, options);
            const data = await read(original.bind(IOUtils), options);
            bytes += data.length;
            return data;
          },
        );
        return () => bytes;
      }

      it("is drawn from its first page without reading the whole file", async function () {
        const path = await largePDF();
        const bytesRead = watchReads(path);
        const cover = await findPDFCoverURI(path);
        const {
          colour: [red, green, blue],
        } = await imagePaint(cover!);
        assert.isBelow(Math.max(red, green, blue), 60);
        assert.isBelow(bytesRead(), (await IOUtils.stat(path)).size! / 4);
      });

      it("is not drawn when the file can no longer be read", async function () {
        const path = await largePDF();
        let reads = 0;
        watchReads(path, async (read, options) => {
          if (reads++ > 0) throw new Error("File gone");
          return read(path, options);
        });
        let error: unknown;
        try {
          await findPDFCoverURI(path);
        } catch (caught) {
          error = caught;
        }
        assert.match(String(error), /File gone/);
      });
    });

    describe("is kept on disk", function () {
      let item: Zotero.Item;
      let attachment: Zotero.Item;
      let path: string;
      let modified: number;

      /**
       * Replace the PDF without Zotero noticing, keeping its modification time.
       */
      async function replacePDF(bytes: Uint8Array): Promise<void> {
        await IOUtils.write(path, bytes);
        await IOUtils.setModificationTime(path, modified);
      }

      beforeEach(async function () {
        item = await book();
        attachment = await attachPDF(PORTRAIT_PAGE, item);
        path = (await attachment.getFilePathAsync()) as string;
        modified = (await IOUtils.stat(path)).lastModified!;
        await assertCover(await displayedCover(item), "attachment", 2 / 3);
        // Change the page but neither the file's size nor its modification
        // time, so that a cover rendered afresh can be told apart from the
        // one on disk.
        const landscape = pdfBytes(LANDSCAPE_PAGE);
        assert.equal(landscape.length, (await IOUtils.stat(path)).size);
        await replacePDF(landscape);
      });

      it("across sessions, until the attachment file is renamed", async function () {
        CoverProvider.clearCache();
        await assertCover(await findCover(item), "attachment", 2 / 3);
        await attachment.renameAttachmentFile("renamed.pdf");
        await assertCover(await findCover(item), "attachment", 3 / 2);
      });

      it("until the file's size changes", async function () {
        await replacePDF(
          pdfBytes({
            ...LANDSCAPE_PAGE,
            content: "BT /F1 24 Tf 30 100 Td (Revised cover) Tj ET",
          }),
        );
        CoverProvider.clearCache();
        await assertCover(await findCover(item), "attachment", 3 / 2);
      });

      it("until the file's modification time changes", async function () {
        await IOUtils.setModificationTime(path, modified + 60_000);
        CoverProvider.clearCache();
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
