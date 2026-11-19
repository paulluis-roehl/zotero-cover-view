import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { pruneExpiredMetadataSearchCache } from "../src/modules/covers/metadataCover";
import {
  clearPref,
  createItems,
  ItemSpec,
  patch,
  setPref,
  until,
} from "./helpers/gridFixture";
import {
  assertCover,
  findCover,
  useCoverProvider,
  TALL,
  WIDE,
} from "./helpers/coverLookup";
import {
  fakeOpenLibrary,
  imageBytes,
  interceptOpenLibrary,
  InventedCreator,
  inventBook,
  uniqueEditionKey,
  uniqueISBN,
} from "./helpers/testEnvironment";

const DAY = 24 * 60 * 60 * 1000;

function jpeg(ratio: number): Uint8Array {
  return imageBytes(60 * ratio, 60, "image/jpeg");
}

/** The name Open Library is searched with for an author. */
function authorName({ firstName, lastName }: InventedCreator): string {
  return `${lastName}, ${firstName}`;
}

async function book(
  spec: ItemSpec & {
    creators?: _ZoteroTypes.Item.CreatorJSON[];
    isbn?: string;
  } = {},
): Promise<Zotero.Item> {
  const [item] = await createItems([
    {
      ...spec,
      setup: (item) => {
        if (spec.creators) item.setCreators(spec.creators);
        if (spec.isbn) item.setField("ISBN", spec.isbn);
        spec.setup?.(item);
      },
    },
  ]);
  return item;
}

/** A book by an invented author, with a title not searched for before. */
async function inventedBook(spec: ItemSpec & { isbn?: string } = {}) {
  const { title, creator } = inventBook();
  const item = await book({
    title,
    creators: [{ ...creator, creatorType: "author" }],
    ...spec,
  });
  return { item, title, author: authorName(creator) };
}

function hyphenated(isbn: string): string {
  return `${isbn.slice(0, 3)}-${isbn.slice(3, 4)}-${isbn.slice(4, 8)}-${isbn.slice(8, 12)}-${isbn.slice(12)}`;
}

/** Let `days` pass for the rest of the current test. */
function passDays(days: number): void {
  const now = Date.now;
  patch(Date, "now", () => now.call(Date) + days * DAY);
}

describe("online cover", function () {
  this.timeout(20000);

  beforeEach(useCoverProvider);

  it("is not looked up unless enabled in the preferences", async function () {
    clearPref("fetchISBNCover");
    clearPref("fetchMetadataCover");
    const library = fakeOpenLibrary();
    const isbn = uniqueISBN();
    library.addISBNCover(isbn, jpeg(TALL));
    const { item, title, author } = await inventedBook({ isbn });
    library.addBook(title, author, jpeg(WIDE));
    await assertCover(await findCover(item), "placeholder");
    assert.isEmpty(library.requests, "Open Library is not contacted");
  });

  describe("found by ISBN", function () {
    beforeEach(function () {
      setPref("fetchISBNCover", true);
      setPref("fetchMetadataCover", false);
    });

    it("is the cover of the first of the item's ISBNs that has one", async function () {
      const library = fakeOpenLibrary();
      const [missing, found] = [uniqueISBN(), uniqueISBN()];
      library.addISBNCover(found, jpeg(TALL));
      const item = await book({
        isbn: `${hyphenated(missing)} ${hyphenated(found)}`,
      });
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is not looked up for an ISBN with an invalid checksum", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      const invalid = `${isbn.slice(0, 12)}${(Number(isbn[12]) + 1) % 10}`;
      library.addISBNCover(invalid, jpeg(TALL));
      await assertCover(
        await findCover(await book({ isbn: invalid })),
        "placeholder",
      );
    });

    it("is remembered as missing", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      const item = await book({ isbn });
      await assertCover(await findCover(item), "placeholder");
      library.addISBNCover(isbn, jpeg(TALL));
      await assertCover(await findCover(item), "placeholder");
    });

    it("is not taken from a download that is not a JPEG", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      library.addISBNCover(isbn, imageBytes(60 * WIDE, 60, "image/png"));
      const item = await book({ isbn });
      await assertCover(await findCover(item), "placeholder");
      library.addISBNCover(isbn, jpeg(TALL));
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is kept for use while Open Library is unavailable", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      library.addISBNCover(isbn, jpeg(TALL));
      const item = await book({ isbn });
      await assertCover(await findCover(item), "online", TALL);
      library.available = false;
      CoverProvider.clearCache();
      await assertCover(await findCover(item), "online", TALL);
    });
  });

  describe("found by title and creator", function () {
    beforeEach(function () {
      setPref("fetchISBNCover", false);
      setPref("fetchMetadataCover", true);
    });

    it("is found without ISBN lookup and leaves the item unchanged", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      library.addISBNCover(isbn, jpeg(TALL));
      const { item, title, author } = await inventedBook({ isbn });
      library.addBook(title, author, jpeg(WIDE));
      const before = item.toJSON();
      await assertCover(await findCover(item), "online", WIDE);
      assert.deepEqual(item.toJSON(), before);
      assert.isEmpty(item.getAttachments());
    });

    it("is not looked up when only ISBN lookup is enabled", async function () {
      setPref("fetchISBNCover", true);
      setPref("fetchMetadataCover", false);
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addBook(title, author, jpeg(WIDE));
      await assertCover(await findCover(item), "placeholder");
    });

    it("is looked up only for books with a title and a creator", async function () {
      const key = uniqueEditionKey();
      // Answer every search, whatever it asks for.
      interceptOpenLibrary((url) =>
        url.includes("/search.json")
          ? { json: { docs: [{ cover_edition_key: key }] } }
          : { bytes: jpeg(WIDE) },
      );
      const { creator } = inventBook();
      const creators = [{ ...creator, creatorType: "author" as const }];
      for (const [description, spec] of [
        ["book section", { itemType: "bookSection", creators }],
        ["journal article", { itemType: "journalArticle", creators }],
        [
          "book without a title",
          { creators, setup: (item) => item.setField("title", "") },
        ],
        ["book without a creator", {}],
      ] as [string, Parameters<typeof book>[0]][])
        await assertCover(
          await findCover(await book(spec)),
          "placeholder",
          undefined,
          description,
        );
    });

    it("is looked up once a book section becomes a book", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook({
        itemType: "bookSection",
      });
      library.addBook(title, author, jpeg(TALL));
      await assertCover(await findCover(item), "placeholder");
      item.setType(Zotero.ItemTypes.getID("book") as number);
      await item.saveTx();
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is searched for by the first author, not by other creators or the creator label", async function () {
      const library = fakeOpenLibrary();
      const { title } = inventBook();
      const [translator, first, second, third] = Array.from(
        { length: 4 },
        () => inventBook().creator,
      );
      for (const creator of [translator, second, third])
        library.addBook(title, authorName(creator), jpeg(WIDE));
      library.addBook(title, authorName(first), jpeg(TALL));
      const item = await book({
        title,
        creators: [
          { ...translator, creatorType: "translator" },
          { ...first, creatorType: "author" },
          { ...second, creatorType: "author" },
          { ...third, creatorType: "author" },
        ],
      });
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is searched for by the first author's surname alone if their full name finds nothing", async function () {
      const library = fakeOpenLibrary();
      const { title, creator } = inventBook();
      library.addBook(title, creator.lastName, jpeg(TALL));
      const item = await book({
        title,
        creators: [
          {
            firstName: `Sir ${creator.firstName}`,
            lastName: creator.lastName,
            creatorType: "author",
          },
        ],
      });
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is searched for by the final name of a single-field author", async function () {
      const library = fakeOpenLibrary();
      const { title, creator } = inventBook();
      const name = `${creator.firstName} ${creator.lastName}`;
      library.addBook(title, creator.lastName, jpeg(TALL));
      const item = await book({
        title,
        creators: [{ name, creatorType: "author" }],
      });
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is the cover of the first search result with a usable cover edition", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      const [first, second] = [uniqueEditionKey(), uniqueEditionKey()];
      library.addEditionCover(first, jpeg(TALL));
      library.addEditionCover(second, jpeg(WIDE));
      library.addEditionCover("../other", jpeg(WIDE));
      library.addSearchResults(title, author, [
        null,
        { isbn: [uniqueISBN()] },
        { cover_edition_key: "../other" },
        { cover_edition_key: first },
        { cover_edition_key: second },
      ]);
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is not taken from a search result far down the list", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      const key = uniqueEditionKey();
      library.addEditionCover(key, jpeg(TALL));
      library.addSearchResults(title, author, [
        ...Array.from({ length: 20 }, () => ({})),
        { cover_edition_key: key },
      ]);
      await assertCover(await findCover(item), "placeholder");
    });

    it("is not taken from a download that is not a JPEG", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      const key = library.addBook(
        title,
        author,
        imageBytes(60 * WIDE, 60, "image/png"),
      );
      await assertCover(await findCover(item), "placeholder");
      library.addEditionCover(key, jpeg(TALL));
      await assertCover(await findCover(item), "online", TALL);
    });

    it("falls back to a placeholder when the found edition has no cover", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addSearchResults(title, author, [
        { cover_edition_key: uniqueEditionKey() },
      ]);
      await assertCover(await findCover(item), "placeholder");
    });

    it("falls back to a placeholder when the search fails", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addBook(title, author, jpeg(TALL));
      library.available = false;
      await assertCover(await findCover(item), "placeholder");
    });

    it("is downloaded again without searching again once its saved image is removed", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addBook(title, author, jpeg(TALL));
      const cover = await findCover(item);
      await assertCover(cover, "online", TALL);
      await IOUtils.remove(
        Services.io.newURI(cover.uri).QueryInterface!(Ci.nsIFileURL).file.path,
      );
      library.addSearchResults(title, author, []);
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is searched for again after the title changes", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addBook(title, author, jpeg(TALL));
      await assertCover(await findCover(item), "online", TALL);
      const changed = inventBook().title;
      library.addBook(changed, author, jpeg(WIDE));
      item.setField("title", changed);
      await item.saveTx();
      await assertCover(await findCover(item), "online", WIDE);
    });

    it("is searched for once by items with the same title and author at the same time", async function () {
      const { title, creator } = inventBook();
      const key = uniqueEditionKey();
      let release: (() => void) | undefined;
      // Only the first search finds the cover.
      interceptOpenLibrary((url) => {
        if (!url.includes("/search.json")) return { bytes: jpeg(TALL) };
        if (release) return { json: { docs: [] } };
        return new Promise((resolve) => {
          release = () =>
            resolve({ json: { docs: [{ cover_edition_key: key }] } });
        });
      });
      const creators = [{ ...creator, creatorType: "author" as const }];
      const items = await createItems(
        Array.from({ length: 2 }, () => ({
          title,
          setup: (item: Zotero.Item) => item.setCreators(creators),
        })),
      );
      const covers = items.map((item) => findCover(item));
      await until(() => release, "the first search to start");
      release!();
      for (const cover of covers)
        await assertCover(await cover, "online", TALL);
    });
  });

  describe("remembered from earlier lookups", function () {
    beforeEach(function () {
      setPref("fetchISBNCover", true);
      setPref("fetchMetadataCover", true);
    });

    it("is looked up again by ISBN a week after it was missing", async function () {
      const library = fakeOpenLibrary();
      const isbn = uniqueISBN();
      const item = await book({ isbn });
      await assertCover(await findCover(item), "placeholder");
      library.addISBNCover(isbn, jpeg(TALL));
      passDays(8);
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is searched for again a week after a search found nothing", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      await assertCover(await findCover(item), "placeholder");
      library.addBook(title, author, jpeg(TALL));
      await assertCover(await findCover(item), "placeholder");
      passDays(8);
      await assertCover(await findCover(item), "online", TALL);
    });

    it("is looked up again a week after the found edition had no cover", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      const key = uniqueEditionKey();
      library.addSearchResults(title, author, [{ cover_edition_key: key }]);
      await assertCover(await findCover(item), "placeholder");
      library.addEditionCover(key, jpeg(TALL));
      passDays(8);
      await assertCover(await findCover(item), "online", TALL);
    });

    it("keeps a successful search for more than a month", async function () {
      const library = fakeOpenLibrary();
      const { item, title, author } = await inventedBook();
      library.addBook(title, author, jpeg(TALL));
      await assertCover(await findCover(item), "online", TALL);
      library.addBook(title, author, jpeg(WIDE));
      passDays(31);
      await pruneExpiredMetadataSearchCache();
      await assertCover(await findCover(item), "online", TALL);
    });
  });
});
