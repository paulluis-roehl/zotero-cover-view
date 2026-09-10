import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import { findEPUBCoverURI } from "../src/modules/epubCover";
import { CoverProvider } from "../src/modules/coverProvider";

describe("EPUB cover discovery", function () {
  const archiveURI = "file:///books/example.epub";
  const entries = new Map<string, string>();
  let originalRead: typeof Zotero.File.getContentsFromURLAsync;
  let originalPath: typeof Zotero.File.pathToFileURI;
  let originalGet: typeof Zotero.Items.get;
  let toolkitDescriptor: PropertyDescriptor | undefined;

  function uri(path: string): string {
    return `jar:${archiveURI}!/${path}`;
  }

  function fixture(
    manifest: string,
    metadata = "",
    packagePath = "OPS/package.opf",
  ): void {
    entries.set(
      uri("META-INF/container.xml"),
      `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="${packagePath}"
          media-type="application/oebps-package+xml"/></rootfiles>
      </container>`,
    );
    entries.set(
      uri(packagePath.split("/").map(encodeURIComponent).join("/")),
      `<package xmlns="http://www.idpf.org/2007/opf">
        <metadata>${metadata}</metadata><manifest>${manifest}</manifest>
      </package>`,
    );
  }

  async function rejects(action: () => Promise<unknown>, message: RegExp) {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), message);
  }

  function attachment(id: number, path: () => Promise<string | false>) {
    return {
      id,
      isFileAttachment: () => true,
      attachmentContentType: "application/epub+zip",
      getFilePathAsync: path,
    } as unknown as Zotero.Item;
  }

  beforeEach(function () {
    entries.clear();
    originalRead = Zotero.File.getContentsFromURLAsync;
    originalPath = Zotero.File.pathToFileURI;
    originalGet = Zotero.Items.get;
    toolkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ztoolkit");
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: new BasicTool(),
    });
    Zotero.File.pathToFileURI = () => archiveURI;
    Zotero.File.getContentsFromURLAsync = (async (url: string) => {
      const text = entries.get(url);
      if (text === undefined) throw new Error(`Missing archive entry: ${url}`);
      return text;
    }) as typeof originalRead;
  });

  afterEach(function () {
    Zotero.File.getContentsFromURLAsync = originalRead;
    Zotero.File.pathToFileURI = originalPath;
    Zotero.Items.get = originalGet;
    if (toolkitDescriptor) {
      Object.defineProperty(globalThis, "ztoolkit", toolkitDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "ztoolkit");
    }
  });

  it("prefers EPUB 3 cover-image tokens over EPUB 2 metadata", async function () {
    fixture(
      `<item id="old" href="old.jpg"/>
       <item properties="nav cover-image scripted" href="new.jpg"/>`,
      '<meta name="cover" content="old"/>',
    );
    assert.equal(await findEPUBCoverURI("book.epub"), uri("OPS/new.jpg"));
  });

  it("finds EPUB 2 covers by manifest ID", async function () {
    fixture(
      '<item id="cover" href="cover.jpg"/>',
      '<meta name="cover" content="cover"/>',
    );
    assert.equal(await findEPUBCoverURI("book.epub"), uri("OPS/cover.jpg"));
  });

  it("resolves nested, percent-encoded image references", async function () {
    fixture(
      '<item properties="cover-image" href="../Images/cover%20image.jpg?download=1#cover"/>',
    );
    assert.equal(
      await findEPUBCoverURI("book.epub"),
      uri("Images/cover%20image.jpg"),
    );
  });

  it("preserves literal percent, query and fragment characters in container paths", async function () {
    fixture(
      '<item properties="cover-image" href="cover.jpg"/>',
      "",
      "OPS%20#?/package.opf",
    );
    assert.equal(
      await findEPUBCoverURI("book.epub"),
      uri("OPS%2520%23%3F/cover.jpg"),
    );
  });

  it("decodes manifest references exactly once", async function () {
    fixture('<item properties="cover-image" href="cover%2520%23%3F.jpg"/>');
    assert.equal(
      await findEPUBCoverURI("book.epub"),
      uri("OPS/cover%2520%23%3F.jpg"),
    );
  });

  it("resolves leading slashes from the archive root", async function () {
    fixture('<item properties="cover-image" href="/Images/cover.jpg"/>');
    assert.equal(await findEPUBCoverURI("book.epub"), uri("Images/cover.jpg"));
  });

  describe("external references", function () {
    for (const href of [
      "https://example.com/cover.jpg",
      "//example.com/cover.jpg",
      "data:image/png,abc",
    ]) {
      it(`rejects external reference ${href}`, async function () {
        fixture(`<item properties="cover-image" href="${href}"/>`);
        await rejects(
          () => findEPUBCoverURI("book.epub"),
          /External EPUB cover/,
        );
      });
    }
  });

  describe("invalid paths", function () {
    for (const href of [
      "../../cover.jpg",
      "%2e%2e/%2e%2e/cover.jpg",
      "images%2fcover.jpg",
      "cover%ZZ.jpg",
    ]) {
      it(`rejects invalid path ${href}`, async function () {
        fixture(`<item properties="cover-image" href="${href}"/>`);
        await rejects(
          () => findEPUBCoverURI("book.epub"),
          /escapes|separator|URIError/,
        );
      });
    }
  });

  it("rejects a container path that escapes the archive", async function () {
    fixture("", "", "../package.opf");
    await rejects(() => findEPUBCoverURI("book.epub"), /escapes/);
  });

  describe("malformed XML", function () {
    for (const path of ["META-INF/container.xml", "OPS/package.opf"]) {
      it(`reports malformed XML in ${path}`, async function () {
        fixture("");
        entries.set(uri(path), "<broken>");
        await rejects(() => findEPUBCoverURI("book.epub"), /Invalid EPUB XML/);
      });
    }
  });

  it("ignores cover declarations outside the manifest and metadata", async function () {
    fixture(
      "",
      '<extension><item properties="cover-image" href="wrong.jpg"/></extension>',
    );
    assert.isNull(await findEPUBCoverURI("book.epub"));
  });

  describe("attachment fallback", function () {
    for (const failure of ["missing", "lookup error", "no cover", "bad XML"]) {
      it(`tries another attachment after ${failure}`, async function () {
        fixture('<item properties="cover-image" href="cover.jpg"/>');
        const validPackage = entries.get(uri("OPS/package.opf"))!;
        const first = attachment(1, async () => {
          if (failure === "missing") return false;
          if (failure === "lookup error") throw new Error("File lookup failed");
          if (failure === "no cover") fixture("");
          if (failure === "bad XML")
            entries.set(uri("OPS/package.opf"), "<broken>");
          return "first.epub";
        });
        const second = attachment(2, async () => {
          entries.set(uri("OPS/package.opf"), validPackage);
          return "second.epub";
        });
        Zotero.Items.get = (() => [first, second]) as typeof originalGet;
        const parent = {
          isFileAttachment: () => false,
          isRegularItem: () => true,
          getAttachments: () => [1, 2],
        } as unknown as Zotero.Item;
        assert.equal(
          await CoverProvider.findCover(parent),
          uri("OPS/cover.jpg"),
        );
      });
    }
  });

  it("accepts an EPUB attachment directly", async function () {
    fixture('<item properties="cover-image" href="cover.jpg"/>');
    assert.equal(
      await CoverProvider.findCover(attachment(1, async () => "book.epub")),
      uri("OPS/cover.jpg"),
    );
  });

  it("returns null when an attachment lookup fails", async function () {
    assert.isNull(
      await CoverProvider.findCover(
        attachment(1, async () => {
          throw new Error("File lookup failed");
        }),
      ),
    );
  });
});
