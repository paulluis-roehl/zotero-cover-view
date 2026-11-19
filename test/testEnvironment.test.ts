import { assert } from "chai";
import { findEPUBCoverURI, readURIText } from "../src/modules/covers/epubCover";
import { findPDFCoverURI } from "../src/modules/covers/pdfCover";
import {
  epubBytes,
  imageBytes,
  interceptOpenLibrary,
  inventBook,
  pdfBytes,
  runDirectory,
  scratchDirectory,
  scratchFile,
  uniqueEditionKey,
  uniqueISBN,
} from "./helpers/testEnvironment";
import { BasicTool } from "zotero-plugin-toolkit";
import { patch } from "./helpers/gridFixture";

describe("test environment", function () {
  describe("scratch files", function () {
    it("lives in a project-named run directory under the OS temp directory", async function () {
      const directory = await scratchDirectory();
      assert.equal(PathUtils.parent(runDirectory()), PathUtils.tempDir);
      assert.match(PathUtils.filename(runDirectory()), /^zotero-cover-view-/);
      assert.equal(PathUtils.parent(directory), runDirectory());
      assert.notEqual(directory, await scratchDirectory());
      assert.isEmpty(await IOUtils.getChildren(directory));
    });

    it("writes a named file into its own directory", async function () {
      const path = await scratchFile("note.txt", "hello");
      assert.equal(PathUtils.filename(path), "note.txt");
      assert.equal(await IOUtils.readUTF8(path), "hello");
    });
  });

  describe("generated files", function () {
    async function decode(src: string) {
      const image = new (Zotero.getMainWindow()!.Image)();
      image.src = src;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }

    for (const type of ["image/png", "image/jpeg"] as const) {
      it(`opens a generated ${type} image`, async function () {
        const bytes = imageBytes(30, 50, type);
        const base64 = Zotero.getMainWindow()!.btoa(
          String.fromCharCode(...bytes),
        );
        assert.deepEqual(await decode(`data:${type};base64,${base64}`), {
          width: 30,
          height: 50,
        });
      });
    }

    it("opens a generated PDF", async function () {
      const path = await scratchFile(
        "book.pdf",
        pdfBytes({ width: 200, height: 300 }),
      );
      assert.deepEqual(await decode((await findPDFCoverURI(path, 100))!), {
        width: 100,
        height: 150,
      });
    });

    it("opens a generated EPUB and reads its cover image", async function () {
      patch(
        globalThis as unknown as { ztoolkit: unknown },
        "ztoolkit",
        new BasicTool(),
      );
      const path = await scratchFile("book.epub", epubBytes());
      const cover = await findEPUBCoverURI(path);
      assert.equal(
        cover,
        `jar:${Zotero.File.pathToFileURI(path)}!/OPS/cover.png`,
      );
      assert.include(
        await readURIText(cover!.replace("cover.png", "package.opf")),
        "cover-image",
      );
      assert.deepEqual(await decode(cover!), { width: 40, height: 60 });
    });
  });

  describe("invented data", function () {
    it("generates unique, checksum-valid ISBN-13s outside allocated groups", function () {
      const isbns = Array.from({ length: 50 }, uniqueISBN);
      assert.equal(new Set(isbns).size, isbns.length);
      for (const isbn of isbns) {
        assert.match(isbn, /^9795\d{9}$/);
        assert.equal(Zotero.Utilities.cleanISBN(isbn), isbn);
      }
    });

    it("generates unique edition keys and book titles", function () {
      const keys = Array.from({ length: 20 }, uniqueEditionKey);
      assert.equal(new Set(keys).size, keys.length);
      for (const key of keys) assert.match(key, /^OL\d+M$/);
      const books = Array.from({ length: 20 }, inventBook);
      assert.equal(new Set(books.map((book) => book.title)).size, 20);
      for (const book of books) {
        assert.isNotEmpty(book.creator.firstName);
        assert.isNotEmpty(book.creator.lastName);
        assert.match(book.year, /^\d{4}$/);
        assert.isNotEmpty(book.publisher);
      }
    });
  });

  describe("Open Library interceptor", function () {
    let original: typeof Zotero.HTTP.request;

    before(function () {
      original = Zotero.HTTP.request;
    });

    it("answers Open Library requests and passes others through", async function () {
      const interceptor = interceptOpenLibrary((url) => ({
        json: { url },
      }));
      const response = (await Zotero.HTTP.request(
        "GET",
        "https://openlibrary.org/search.json?q=x",
      )) as unknown as { status: number; response: ArrayBuffer };
      assert.equal(response.status, 200);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(response.response)),
        { url: "https://openlibrary.org/search.json?q=x" },
      );
      const local = await Zotero.HTTP.request(
        "GET",
        Zotero.File.pathToFileURI(
          await scratchFile("local.txt", "passed through"),
        ),
      );
      assert.equal(local.responseText, "passed through");
      assert.deepEqual(interceptor.requests, [
        "https://openlibrary.org/search.json?q=x",
      ]);
      interceptor.restore();
      assert.strictEqual(Zotero.HTTP.request, original);
    });

    it("rejects statuses the request does not accept, like Zotero", async function () {
      interceptOpenLibrary(() => ({ status: 404 }));
      const url = "https://covers.openlibrary.org/b/isbn/0-L.jpg";
      const accepted = (await Zotero.HTTP.request("GET", url, {
        successCodes: [200, 404],
      })) as unknown as { status: number };
      assert.equal(accepted.status, 404);
      for (const options of [{}, { successCodes: [200] }]) {
        let error: unknown;
        try {
          await Zotero.HTTP.request("GET", url, options);
        } catch (caught) {
          error = caught;
        }
        assert.match(String(error), /Unexpected status 404/);
      }
    });

    it("is left active by a test that ends without restoring it", function () {
      // A failing test would stop here, before any cleanup of its own.
      interceptOpenLibrary(() => ({ status: 404 }));
      assert.notStrictEqual(Zotero.HTTP.request, original);
    });

    it("has been restored before the next test", function () {
      assert.strictEqual(Zotero.HTTP.request, original);
    });
  });
});
