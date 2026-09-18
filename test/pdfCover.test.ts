import { assert } from "chai";
import {
  cachePDFCover,
  deleteCachedPDFCover,
  findPDFCoverURI,
  getCachedPDFCover,
} from "../src/modules/covers/pdfCover";

describe("PDF cover rendering", function () {
  it("renders a real PDF with Zotero's document worker", async function () {
    const filePath = PathUtils.join(
      PathUtils.tempDir,
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
    try {
      const cover = await findPDFCoverURI(filePath, 100);
      assert.match(cover!, /^data:image\/png;base64,/);

      const image = Zotero.getMainWindow()!.document.createElement("img");
      await new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener(
          "error",
          () => reject(new Error("Image failed to load")),
          { once: true },
        );
        image.src = cover!;
      });
      assert.isAbove(image.naturalWidth, 0);
      assert.isAbove(image.naturalHeight, 0);
    } finally {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
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
});
