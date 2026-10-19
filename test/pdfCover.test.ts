import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import {
  cachePDFCover,
  createPDFCacheSignature,
  deleteCachedPDFCover,
  findPDFCoverURI,
  getCachedPDFCover,
} from "../src/modules/covers/pdfCover";

describe("PDF cover rendering", function () {
  let filePath: string;

  before(async function () {
    const directory = PathUtils.join(
      PathUtils.tempDir,
      "opencode",
      "pdf-cover-sharpness",
    );
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    filePath = PathUtils.join(
      directory,
      `cover-view-${Zotero.Utilities.randomString()}.pdf`,
    );
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      "<< /Length 37 >>\nstream\nBT /F1 24 Tf 30 150 Td (Cover) Tj ET\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += "0000000000 65535 f \n";
    pdf += offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

    await IOUtils.write(filePath, new TextEncoder().encode(pdf));
  });

  after(async function () {
    await IOUtils.remove(filePath, { ignoreAbsent: true });
  });

  async function dimensions(cover: string | null) {
    assert.match(cover!, /^data:image\/png;base64,/);
    const image = new (Zotero.getMainWindow()!.Image)();
    image.src = cover!;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }

  it("renders a complete sharp page for a 2x Item Pane preview", async function () {
    const cover = await findPDFCoverURI(filePath);
    const image = await dimensions(cover);
    assert.isAtLeast(image.width, 1200);
    assert.isAtLeast(image.height, 1800);
    assert.closeTo(image.width / image.height, 2 / 3, 0.001);
  });

  it("uses actual page width for an explicit thumbnail size", async function () {
    assert.deepEqual(await dimensions(await findPDFCoverURI(filePath, 100)), {
      width: 100,
      height: 150,
    });
  });

  it("bounds oversized requests while retaining the complete page ratio", async function () {
    const image = await dimensions(await findPDFCoverURI(filePath, 1e9));
    assert.isAtMost(image.width, 4096);
    assert.isAtMost(image.height, 4096);
    assert.isAtMost(image.width * image.height, 16_777_216);
    assert.closeTo(image.width / image.height, 2 / 3, 0.001);
  });

  it("regenerates covers cached before the sharp-preview policy", async function () {
    const itemID = Math.floor(Math.random() * 1_000_000_000);
    const attachment = { id: 42, dateModified: "2026-10-18" } as Zotero.Item;
    const signature = createPDFCacheSignature(attachment, filePath);
    const legacySignature = `v2:42:2026-10-18:${filePath}`;
    const legacyCover = "data:image/png;base64,iVBORw0KGgo=";
    try {
      await cachePDFCover(itemID, legacySignature, legacyCover);
      assert.isNull(await getCachedPDFCover(itemID, signature));
      const cover = await findPDFCoverURI(filePath);
      await cachePDFCover(itemID, signature, cover!);
      const cached = await getCachedPDFCover(itemID, signature);
      assert.equal(cached, cover);
      assert.isAtLeast((await dimensions(cached)).height, 1800);
    } finally {
      await deleteCachedPDFCover(itemID);
    }
  });

  it("rejects an invalid target width", async function () {
    let error: unknown;
    try {
      await findPDFCoverURI("book.pdf", 0);
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /positive number/);
  });

  it("keeps older Zotero's worker fallback sharp on a small page", async function () {
    const win = Zotero.getMainWindow()!;
    const originalEval = win.eval;
    // Simulate the missing ES module on older Zotero, but use the real worker.
    win.eval = () => {
      throw new Error("Reader ES module unavailable");
    };
    try {
      const image = await dimensions(await findPDFCoverURI(filePath));
      assert.isAtLeast(image.width, 1200);
      assert.isAtLeast(image.height, 1800);
      assert.closeTo(image.width / image.height, 2 / 3, 0.001);
    } finally {
      win.eval = originalEval;
    }
  });

  it("hits, misses, and removes the persistent PDF cache", async function () {
    const itemID = Math.floor(Math.random() * 1_000_000_000);
    const cover = "data:image/png;base64,iVBORw0KGgo=";
    const imagePath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      `${itemID}.png`,
    );
    try {
      assert.isNull(await getCachedPDFCover(itemID, "v1"));
      await cachePDFCover(itemID, "v1", cover);
      assert.equal(await getCachedPDFCover(itemID, "v1"), cover);
      assert.deepEqual(
        Array.from(await IOUtils.read(imagePath)),
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      assert.isNull(await getCachedPDFCover(itemID, "v2"));
      await deleteCachedPDFCover(itemID);
      assert.isNull(await getCachedPDFCover(itemID, "v1"));
    } finally {
      await deleteCachedPDFCover(itemID);
    }
  });

  it("keeps a PDF cover file on metadata-only invalidation", async function () {
    const itemID = Math.floor(Math.random() * 1_000_000_000);
    const cover = "data:image/png;base64,iVBORw0KGgo=";
    try {
      await cachePDFCover(itemID, "unchanged-attachment", cover);
      CoverProvider.invalidate(itemID, { discardPDF: false });
      assert.equal(
        await getCachedPDFCover(itemID, "unchanged-attachment"),
        cover,
      );
    } finally {
      await deleteCachedPDFCover(itemID);
    }
  });
});
