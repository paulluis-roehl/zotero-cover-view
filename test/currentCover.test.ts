import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import {
  createItems,
  ItemSpec,
  onTeardown,
  setPref,
  until,
} from "./helpers/gridFixture";
import {
  assertCover,
  attach,
  findCover,
  useCoverProvider,
  TALL,
  WIDE,
  SQUARE,
} from "./helpers/coverLookup";
import {
  epubBytes,
  fakeOpenLibrary,
  imageBytes,
  imageSize,
  interceptOpenLibrary,
  inventBook,
  pdfBytes,
  scratchFile,
  uniqueISBN,
} from "./helpers/testEnvironment";

async function book(spec: ItemSpec = {}): Promise<Zotero.Item> {
  const [item] = await createItems([spec]);
  return item;
}

function image(ratio: number): Promise<string> {
  return scratchFile("cover.png", imageBytes(60 * ratio, 60));
}

function online(ratio: number): Uint8Array {
  return imageBytes(60 * ratio, 60, "image/jpeg");
}

/** The current cover as the provider caches it for display. */
function displayedCover(item: Zotero.Item) {
  CoverProvider.cacheCover(item);
  return CoverProvider.getCoverResult(item.id);
}

describe("current cover", function () {
  this.timeout(20000);

  beforeEach(useCoverProvider);

  describe("among an item's attachments", function () {
    it("comes from the attachment Zotero ranks best, not from an image first", async function () {
      const parent = await book();
      await attach(await image(TALL), "image/png", { parent });
      await attach(
        await scratchFile("book.epub", epubBytes()),
        "application/epub+zip",
        {
          parent,
        },
      );
      await attach(
        await scratchFile("book.pdf", pdfBytes({ width: 300, height: 200 })),
        "application/pdf",
        { parent },
      );
      const [best] = await parent.getBestAttachments();
      const ratios: Record<string, number> = {
        "application/epub+zip": 40 / 60,
        "application/pdf": 300 / 200,
      };
      assert.property(
        ratios,
        best.attachmentContentType,
        "Zotero ranks an image last",
      );
      await assertCover(
        await findCover(parent),
        "attachment",
        ratios[best.attachmentContentType],
      );
    });

    it("passes over attachments that are missing, unreadable, unsupported or without a cover", async function () {
      const parent = await book();
      let day = 1;
      const add = async (file: string, contentType: string) =>
        attach(file, contentType, {
          parent,
          dateAdded: `2020-01-0${day++} 00:00:00`,
        });
      await add(
        await scratchFile("broken.pdf", new Uint8Array([1, 2, 3])),
        "application/pdf",
      );
      await add(
        await scratchFile("book.epub", epubBytes({ manifest: "" })),
        "application/epub+zip",
      );
      await add(await scratchFile("notes.txt", "Notes"), "text/plain");
      const missing = await image(SQUARE);
      await add(missing, "image/png");
      await IOUtils.remove(missing);
      if (!Zotero.isWin) {
        const unreadable = await image(SQUARE);
        await IOUtils.setPermissions(unreadable, 0);
        await add(unreadable, "image/png");
      }
      await add(await image(TALL), "image/png");
      await add(await image(WIDE), "image/png");

      await assertCover(await findCover(parent), "attachment", TALL);
    });
  });

  it("is attachment-derived first, then found by ISBN, then by title and creator, then a placeholder", async function () {
    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", true);
    const library = fakeOpenLibrary();
    const { title, creator } = inventBook();
    const isbn = uniqueISBN();
    library.addISBNCover(isbn, online(TALL));
    library.addBook(
      title,
      `${creator.lastName}, ${creator.firstName}`,
      online(WIDE),
    );
    const item = await book({
      title,
      setup: (item) => {
        item.setField("ISBN", isbn);
        item.setCreators([{ ...creator, creatorType: "author" }]);
      },
    });
    await attach(
      await scratchFile("book.epub", epubBytes({ manifest: "" })),
      "application/epub+zip",
      { parent: item },
    );
    const attachment = await attach(await image(SQUARE), "image/png", {
      parent: item,
    });

    await assertCover(await findCover(item), "attachment", SQUARE);
    await attachment.eraseTx();
    await assertCover(await findCover(item), "online", TALL, "found by ISBN");
    item.setField("ISBN", uniqueISBN());
    await item.saveTx();
    await assertCover(
      await findCover(item),
      "online",
      WIDE,
      "found by title and creator once the ISBN has no cover",
    );
    item.setField("title", inventBook().title);
    await item.saveTx();
    await assertCover(await findCover(item), "placeholder");
  });

  describe("follows Zotero's attachment ranking", function () {
    const urlA = "https://example.invalid/a";
    const urlB = "https://example.invalid/b";
    let item: Zotero.Item;
    let a: Zotero.Item;
    let b: Zotero.Item;
    let changes: number[];

    async function addImage(ratio: number, url: string, dateAdded: string) {
      return attach(await image(ratio), "image/png", {
        parent: item,
        url,
        dateAdded,
      });
    }

    function assertRefreshed(...parents: Zotero.Item[]) {
      for (const parent of parents)
        assert.include(changes, parent.id, "the cover is refreshed");
      changes.length = 0;
    }

    beforeEach(async function () {
      item = await book({ setup: (item) => item.setField("url", urlA) });
      // Matching the parent's URL ranks `a` first.
      a = await addImage(TALL, urlA, "2020-01-01 00:00:00");
      b = await addImage(WIDE, urlB, "2021-01-01 00:00:00");
      changes = [];
      const stop = CoverProvider.onCoverChanged((id) => changes.push(id));
      onTeardown(stop);
    });

    it("by the parent's URL", async function () {
      assert.equal((await item.getBestAttachments())[0].id, a.id);
      await assertCover(await displayedCover(item), "attachment", TALL);
    });

    it("after the parent's URL changes", async function () {
      await displayedCover(item);
      item.setField("url", urlB);
      await item.saveTx();
      assertRefreshed(item);
      await assertCover(await displayedCover(item), "attachment", WIDE);
    });

    it("after an attachment's URL changes", async function () {
      await displayedCover(item);
      a.setField("url", urlB);
      await a.saveTx();
      b.setField("url", urlA);
      await b.saveTx();
      assertRefreshed(item);
      await assertCover(await displayedCover(item), "attachment", WIDE);
    });

    it("when a better-ranked attachment is added", async function () {
      await displayedCover(item);
      await addImage(SQUARE, urlA, "2019-01-01 00:00:00");
      assertRefreshed(item);
      await assertCover(await displayedCover(item), "attachment", SQUARE);
    });

    it("for both items when an attachment moves to another item", async function () {
      const other = await book();
      await displayedCover(item);
      await assertCover(await displayedCover(other), "placeholder");
      a.parentItemID = other.id;
      await a.saveTx();
      assertRefreshed(item, other);
      await assertCover(await displayedCover(item), "attachment", WIDE);
      await assertCover(await displayedCover(other), "attachment", TALL);
    });

    it("when a lower-ranked attachment is removed", async function () {
      await displayedCover(item);
      await b.eraseTx();
      assertRefreshed(item);
      await assertCover(await displayedCover(item), "attachment", TALL);
    });

    it("when the best-ranked attachment is removed", async function () {
      await displayedCover(item);
      await a.eraseTx();
      assertRefreshed(item);
      await assertCover(await displayedCover(item), "attachment", WIDE);
    });
  });

  it("is reused until cover-relevant metadata changes, but not after a tag edit", async function () {
    const item = await book();
    const file = await image(TALL);
    await attach(file, "image/png", { parent: item });
    await assertCover(await displayedCover(item), "attachment");
    const changes: number[] = [];
    onTeardown(CoverProvider.onCoverChanged((id) => changes.push(id)));

    // Without its file, a fresh lookup finds no attachment-derived cover.
    const bytes = await IOUtils.read(file);
    await IOUtils.remove(file);
    item.addTag("Unrelated tag");
    await item.saveTx();
    await assertCover(
      await displayedCover(item),
      "attachment",
      undefined,
      "tag",
    );
    assert.notInclude(changes, item.id);

    const edits: Record<string, () => void> = {
      title: () => item.setField("title", inventBook().title),
      creator: () =>
        item.setCreators([{ ...inventBook().creator, creatorType: "author" }]),
      date: () => item.setField("date", "2024"),
      ISBN: () => item.setField("ISBN", uniqueISBN()),
      "item type": () =>
        item.setType(Zotero.ItemTypes.getID("bookSection") as number),
    };
    let present = false;
    for (const [field, edit] of Object.entries(edits)) {
      // Alternate the file so that each lookup gives a different cover.
      if (present) await IOUtils.write(file, bytes);
      else await IOUtils.remove(file, { ignoreAbsent: true });
      edit();
      await item.saveTx();
      assert.include(changes, item.id, field);
      changes.length = 0;
      await assertCover(
        await displayedCover(item),
        present ? "attachment" : "placeholder",
        undefined,
        field,
      );
      present = !present;
    }
  });

  it("changes with the cover lookup preferences", async function () {
    const library = fakeOpenLibrary();
    const { title, creator } = inventBook();
    const isbn = uniqueISBN();
    library.addISBNCover(isbn, online(TALL));
    library.addBook(
      title,
      `${creator.lastName}, ${creator.firstName}`,
      online(WIDE),
    );
    const item = await book({
      title,
      setup: (item) => {
        item.setField("ISBN", isbn);
        item.setCreators([{ ...creator, creatorType: "author" }]);
      },
    });
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    await assertCover(await displayedCover(item), "placeholder");
    setPref("fetchMetadataCover", true);
    await assertCover(await displayedCover(item), "online", WIDE);
    setPref("fetchISBNCover", true);
    await assertCover(await displayedCover(item), "online", TALL);
    setPref("fetchMetadataCover", false);
    await assertCover(await displayedCover(item), "online", TALL);
    setPref("fetchISBNCover", false);
    await assertCover(await displayedCover(item), "placeholder");
  });

  it("is not replaced by a lookup that an edit made stale", async function () {
    setPref("fetchISBNCover", true);
    let release: (() => void) | undefined;
    interceptOpenLibrary(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ bytes: online(WIDE) });
        }),
    );
    onTeardown(() => release?.());
    const item = await book({
      setup: (item) => item.setField("ISBN", uniqueISBN()),
    });
    const stale = displayedCover(item);
    await until(() => release, "the ISBN lookup to start");

    await attach(await image(TALL), "image/png", { parent: item });
    await assertCover(await displayedCover(item), "attachment", TALL);
    release!();
    assert.isNull(await stale, "the stale lookup is discarded");
    await assertCover(await displayedCover(item), "attachment", TALL);
  });

  it("is published with its image size", async function () {
    const item = await book();
    await attach(
      await scratchFile("cover.png", imageBytes(120, 40)),
      "image/png",
      { parent: item },
    );
    CoverProvider.cacheCover(item);
    assert.isUndefined(
      CoverProvider.getCachedCoverResult(item.id),
      "nothing is published before the cover is resolved",
    );
    const cover = await CoverProvider.getCoverResult(item.id);
    assert.strictEqual(CoverProvider.getCachedCoverResult(item.id), cover);
    assert.deepEqual(
      CoverProvider.getCoverDimensions(cover!.uri),
      await imageSize(cover!.uri),
    );
  });
});
