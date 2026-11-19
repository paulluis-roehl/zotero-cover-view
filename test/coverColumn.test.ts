import { assert } from "chai";
import {
  focusWindow,
  GridWindow,
  ItemSpec,
  onTeardown,
  openGrid,
  painted,
  setPref,
  track,
  until,
} from "./helpers/gridFixture";
import {
  fakeOpenLibrary,
  imageBytes,
  interceptOpenLibrary,
  inventBook,
  scratchFile,
  uniqueISBN,
} from "./helpers/testEnvironment";

function jpeg(): Uint8Array {
  return imageBytes(40, 60, "image/jpeg");
}

function isPlaceholder(uri: string): boolean {
  return uri.startsWith("data:");
}

async function attachCover(parent: Zotero.Item): Promise<Zotero.Item> {
  const file = await scratchFile("cover.png", imageBytes(40, 60));
  const [child] = track(
    await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id }),
  );
  return child;
}

/** Wait until the Cover column shows one cover for `item` that `accepts`. */
async function columnShows(
  view: GridWindow,
  item: Zotero.Item,
  accepts: (uri: string) => boolean,
  description: string,
): Promise<string> {
  const covers = () => {
    try {
      return view.coverColumnCovers(item);
    } catch (error) {
      return String(error);
    }
  };
  return until(
    () => {
      const shown = covers();
      return Array.isArray(shown) && shown.length === 1 && accepts(shown[0])
        ? shown[0]
        : undefined;
    },
    `the Cover column to show ${description}`,
    { observe: covers },
  );
}

async function tileShows(
  view: GridWindow,
  item: Zotero.Item,
  kind: "attachment" | "online" | "placeholder",
): Promise<string> {
  const cover = await until(
    () =>
      view.currentCover(item)?.kind === kind
        ? view.currentCover(item)
        : undefined,
    `the tile to show a ${kind} cover`,
    { observe: () => view.currentCover(item) },
  );
  return cover.uri;
}

/** A book with a cover found by ISBN and one with a cover found by title. */
function booksWithOnlineCovers(): {
  isbn: string;
  edition: string;
  specs: [ItemSpec, ItemSpec];
} {
  const library = fakeOpenLibrary();
  const isbn = uniqueISBN();
  library.addISBNCover(isbn, jpeg());
  const { title, creator } = inventBook();
  const edition = library.addBook(
    title,
    `${creator.lastName}, ${creator.firstName}`,
    jpeg(),
  );
  return {
    isbn,
    edition,
    specs: [
      { setup: (item) => item.setField("ISBN", isbn) },
      {
        title,
        setup: (item) =>
          item.setCreators([{ ...creator, creatorType: "author" }]),
      },
    ],
  };
}

describe("Cover column", function () {
  this.timeout(30000);

  it("shows the same current cover as the item's tile, whatever the grid's decorations", async function () {
    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", true);
    setPref("tileSize", 90);
    setPref("desaturateOnlineCovers", true);
    setPref("showItemTypeIcon", true);
    const { specs } = booksWithOnlineCovers();
    const families = [
      "book",
      "report",
      "audioRecording",
      "film",
      "artwork",
      "dataset",
    ] as const;
    const grid = await openGrid({
      items: [
        {},
        ...specs,
        ...families.map((itemType) => ({ itemType })),
        { itemType: "note", setup: (note) => note.setNote("<p>Notes</p>") },
      ],
    });
    const [attached, byISBN, byTitle, ...placeholders] = grid.items;
    await attachCover(attached);
    const expected = new Map<Zotero.Item, string>([
      [attached, await tileShows(grid, attached, "attachment")],
      [byISBN, await tileShows(grid, byISBN, "online")],
      [byTitle, await tileShows(grid, byTitle, "online")],
    ]);
    for (const item of placeholders)
      expected.set(item, await tileShows(grid, item, "placeholder"));

    grid.showColumn("Cover");
    await grid.showList();
    for (const [item, uri] of expected)
      await columnShows(
        grid,
        item,
        (shown) => shown === uri,
        `the tile's cover for ${item.itemType} ${item.getDisplayTitle()}`,
      );
  });

  it("refreshes when an attachment-derived cover is added and removed, keeping the selection", async function () {
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    const grid = await openGrid({ view: "list", items: 2 });
    const [item, other] = grid.items;
    grid.showColumn("Cover");
    await grid.select([other]);
    const placeholder = await columnShows(
      grid,
      item,
      isPlaceholder,
      "a placeholder cover",
    );

    const attachment = await attachCover(item);
    await columnShows(
      grid,
      item,
      (uri) => uri.includes(attachment.key),
      "the attachment-derived cover",
    );
    await attachment.eraseTx();
    await columnShows(
      grid,
      item,
      (uri) => uri === placeholder,
      "the placeholder cover again",
    );
    assert.deepEqual(grid.selectedItems(), [other.id]);
  });

  it("refreshes when cover-relevant metadata changes", async function () {
    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", false);
    const library = fakeOpenLibrary();
    const isbn = uniqueISBN();
    library.addISBNCover(isbn, jpeg());
    const grid = await openGrid({ view: "list", items: 1 });
    const [item] = grid.items;
    grid.showColumn("Cover");
    const before = await columnShows(
      grid,
      item,
      isPlaceholder,
      "a placeholder cover",
    );

    item.setField("title", inventBook().title);
    await item.saveTx();
    await columnShows(
      grid,
      item,
      (uri) => isPlaceholder(uri) && uri !== before,
      "a placeholder cover for the new title",
    );

    item.setField("ISBN", isbn);
    await item.saveTx();
    await columnShows(
      grid,
      item,
      (uri) => uri.includes(`${isbn}.jpg`),
      "the online-sourced cover found by ISBN",
    );
  });

  it("refreshes when either cover lookup setting changes", async function () {
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    const { isbn, edition, specs } = booksWithOnlineCovers();
    const grid = await openGrid({ view: "list", items: specs });
    const [byISBN, byTitle] = grid.items;
    grid.showColumn("Cover");
    for (const item of [byISBN, byTitle])
      await columnShows(grid, item, isPlaceholder, "a placeholder cover");

    setPref("fetchISBNCover", true);
    await columnShows(
      grid,
      byISBN,
      (uri) => uri.includes(`${isbn}.jpg`),
      "the cover found by ISBN",
    );
    await columnShows(grid, byTitle, isPlaceholder, "a placeholder cover");

    setPref("fetchMetadataCover", true);
    await columnShows(
      grid,
      byTitle,
      (uri) => uri.includes(edition),
      "the cover found by title and creator",
    );

    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    for (const item of [byISBN, byTitle])
      await columnShows(grid, item, isPlaceholder, "a placeholder cover again");
  });

  it("shows covers found after a lookup setting changed while the grid view was active", async function () {
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    const { specs } = booksWithOnlineCovers();
    const grid = await openGrid({ items: specs });
    const [byISBN, byTitle] = grid.items;
    grid.showColumn("Cover");
    for (const item of [byISBN, byTitle])
      await tileShows(grid, item, "placeholder");

    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", true);
    const covers = [
      await tileShows(grid, byISBN, "online"),
      await tileShows(grid, byTitle, "online"),
    ];
    await grid.showList();
    for (const [index, item] of [byISBN, byTitle].entries())
      await columnShows(
        grid,
        item,
        (uri) => uri === covers[index],
        "the online-sourced cover",
      );
  });

  it("shows only the current cover when an earlier online lookup finishes late", async function () {
    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", false);
    const isbn = uniqueISBN();
    const bytes = jpeg();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    onTeardown(() => release());
    const { requests } = interceptOpenLibrary(async () => {
      await gate;
      return { bytes };
    });
    const withISBN: ItemSpec = { setup: (item) => item.setField("ISBN", isbn) };
    const grid = await openGrid({ view: "list", items: [withISBN, withISBN] });
    const [item, twin] = grid.items;
    grid.showColumn("Cover");
    await until(() => requests.length, "the online lookup to start");

    const attachment = await attachCover(item);
    const current = await columnShows(
      grid,
      item,
      (uri) => uri.includes(attachment.key),
      "the attachment-derived cover",
    );
    release();
    // The same reply completes the lookup of a book with the same ISBN.
    await columnShows(
      grid,
      twin,
      (uri) => uri.includes(`${isbn}.jpg`),
      "the online-sourced cover of the other book",
    );
    focusWindow(grid.win);
    await painted(grid.win);
    assert.deepEqual(grid.coverColumnCovers(item), [current]);
  });
});
