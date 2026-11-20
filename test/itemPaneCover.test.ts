import { assert } from "chai";
import {
  createItems,
  focusWindow,
  GridFixture,
  onTeardown,
  openGrid,
  painted,
  patch,
  setPref,
  track,
  until,
} from "./helpers/gridFixture";
import {
  fakeOpenLibrary,
  imageBytes,
  interceptOpenLibrary,
  scratchFile,
  uniqueISBN,
} from "./helpers/testEnvironment";

type ItemDetails = HTMLElement & {
  pinnedPane: string;
  scrollToPane: (id: string, behavior: string) => Promise<void>;
};

/** What the Item Pane's Cover section shows, if it is shown at all. */
interface PaneCover {
  shown: boolean;
  /** The shown cover image; none when the section is empty. */
  uri?: string;
}

function coverSection(win: Window): HTMLElement | null {
  return win.document.querySelector<HTMLElement>(
    "#zotero-item-pane item-pane-custom-section:has(.cover-view-item-pane-image)",
  );
}

function paneCover(win: Window): PaneCover {
  const section = coverSection(win);
  const image = section?.querySelector<HTMLImageElement>("img");
  if (
    !section ||
    !image ||
    section.hidden ||
    win.getComputedStyle(image).visibility === "hidden"
  )
    return { shown: false };
  const uri = image.hidden ? undefined : (image.getAttribute("src") ?? "");
  return { shown: true, uri };
}

async function paneShows(
  grid: GridFixture,
  accepts: (cover: PaneCover) => boolean,
  description: string,
): Promise<void> {
  await until(() => accepts(paneCover(grid.win)), description, {
    observe: () => paneCover(grid.win),
  });
}

function showsAttachment(attachment: Zotero.Item) {
  return (cover: PaneCover) =>
    cover.shown && !!cover.uri?.includes(attachment.key);
}

function showsEmptySection(cover: PaneCover): boolean {
  return cover.shown && cover.uri === undefined;
}

async function attachCover(
  grid: GridFixture,
  parent?: Zotero.Item,
  { width = 40, height = 60 } = {},
): Promise<Zotero.Item> {
  const file = await scratchFile("cover.png", imageBytes(width, height));
  const [attachment] = track(
    await Zotero.Attachments.importFromFile(
      parent
        ? { file, parentItemID: parent.id }
        : { file, collections: [grid.collection.id] },
    ),
  );
  return attachment;
}

describe("Item Pane cover", function () {
  this.timeout(30000);

  beforeEach(function () {
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
  });

  it("shows the current cover of the selected item", async function () {
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    const attachment = await attachCover(grid, item);
    await grid.select([item]);
    await paneShows(
      grid,
      showsAttachment(attachment),
      "the attachment-derived cover",
    );
    const image = coverSection(grid.win)!.querySelector("img")!;
    await until(
      () => image.complete && image.naturalWidth > 0,
      "the cover image to load",
    );
  });

  it("names the section and its sidenav button Cover", async function () {
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    const attachment = await attachCover(grid, item);
    await grid.select([item]);
    await paneShows(grid, showsAttachment(attachment), "the cover");
    const section = coverSection(grid.win)!;
    await until(
      () => section.querySelector(".head .title")?.textContent === "Cover",
      "the section heading to read Cover",
    );
    const button = () =>
      Array.from(
        grid.win.document.querySelectorAll<HTMLElement>(
          "item-pane-sidenav .btn",
        ),
      ).find((candidate) => candidate.dataset.pane === section.dataset.pane);
    await until(
      () => button()?.getAttribute("tooltiptext") === "Cover",
      "the sidenav button's tooltip to read Cover",
      { observe: () => button()?.getAttribute("tooltiptext") },
    );
  });

  it("keeps an empty section instead of a placeholder cover and follows cover changes", async function () {
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    await grid.select([item]);
    await paneShows(grid, showsEmptySection, "an empty section");

    const attachment = await attachCover(grid, item);
    await paneShows(
      grid,
      showsAttachment(attachment),
      "the attachment-derived cover",
    );
    await attachment.eraseTx();
    await paneShows(grid, showsEmptySection, "an empty section again");
  });

  it("follows the selection, and is not shown for several or no selected items", async function () {
    const grid = await openGrid({ items: 2 });
    const [parent, placeholder] = grid.items;
    const child = await attachCover(grid, parent);
    const standalone = await attachCover(grid);
    await grid.showsItems([standalone]);

    for (const attachment of [child, standalone]) {
      await grid.select([attachment]);
      await paneShows(
        grid,
        showsAttachment(attachment),
        "the selected attachment's cover",
      );
    }
    await grid.select([placeholder]);
    await paneShows(grid, showsEmptySection, "an empty section");
    await grid.select([parent]);
    await paneShows(grid, showsAttachment(child), "the parent's cover");
    await grid.select([parent, placeholder]);
    await paneShows(grid, (cover) => !cover.shown, "no section");
    await grid.select([]);
    await paneShows(grid, (cover) => !cover.shown, "no section");
  });

  it("shows the cover once a missing attachment file reappears and the item is selected again", async function () {
    const grid = await openGrid({ items: 1 });
    const [other] = grid.items;
    // Out of view until its file is missing, so that no cover is looked up.
    const [item] = await createItems(1);
    const file = await scratchFile("cover.png", imageBytes(40, 60));
    const bytes = await IOUtils.read(file);
    track(
      await Zotero.Attachments.linkFromFile({ file, parentItemID: item.id }),
    );
    await IOUtils.remove(file);
    item.addToCollection(grid.collection.id);
    await item.saveTx();
    await grid.showsItems([other, item]);
    await grid.select([item]);
    await paneShows(grid, showsEmptySection, "an empty section");

    // Restored outside Zotero, which notices nothing.
    await IOUtils.write(file, bytes);
    await grid.select([other]);
    await paneShows(grid, showsEmptySection, "the other item's empty section");
    await grid.select([item]);
    const uri = Zotero.File.pathToFileURI(file);
    await paneShows(
      grid,
      (cover) => cover.shown && cover.uri === uri,
      "the attachment-derived cover",
    );
  });

  it("refreshes an empty section when a cover lookup setting changes", async function () {
    const isbn = uniqueISBN();
    fakeOpenLibrary().addISBNCover(isbn, imageBytes(40, 60, "image/jpeg"));
    const grid = await openGrid({
      items: [{ setup: (item) => item.setField("ISBN", isbn) }],
    });
    const [item] = grid.items;
    await grid.select([item]);
    await paneShows(grid, showsEmptySection, "an empty section");

    setPref("fetchISBNCover", true);
    await paneShows(
      grid,
      (cover) => cover.shown && !!cover.uri?.includes(`${isbn}.jpg`),
      "the online-sourced cover",
    );
    setPref("fetchISBNCover", false);
    await paneShows(grid, showsEmptySection, "an empty section again");
  });

  it("keeps the current cover when an earlier selection's online lookup finishes late", async function () {
    const isbn = uniqueISBN();
    const bytes = imageBytes(40, 60, "image/jpeg");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    onTeardown(() => release());
    const { requests } = interceptOpenLibrary(async () => {
      await gate;
      return { bytes };
    });
    const grid = await openGrid({
      items: [{ setup: (item) => item.setField("ISBN", isbn) }],
    });
    const [item] = grid.items;
    const standalone = await attachCover(grid);
    await grid.showsItems([standalone]);
    await grid.select([item]);
    await paneShows(grid, showsEmptySection, "an empty section");

    setPref("fetchISBNCover", true);
    await until(() => requests.length, "the online lookup to start");
    // The grid view settles only once the held lookup finishes.
    await grid.pane.selectItems([standalone.id]);
    await paneShows(
      grid,
      showsAttachment(standalone),
      "the attachment-derived cover",
    );
    const current = paneCover(grid.win);

    release();
    await until(
      () => grid.currentCover(item)?.kind === "online",
      "the earlier selection's online cover to arrive",
      { observe: () => grid.currentCover(item) },
    );
    await grid.settled();
    assert.deepEqual(paneCover(grid.win), current);
  });

  it("doesn't jump while a pinned section stays in place across cover changes", async function () {
    const grid = await openGrid({ items: 3 });
    // Layout waits for painted frames, which need an active window.
    focusWindow(grid.win);
    const [covered, empty, wide] = grid.items;
    const coveredCover = await attachCover(grid, covered);
    const wideCover = await attachCover(grid, wide, { width: 120, height: 40 });
    const selections: [Zotero.Item, Zotero.Item | undefined][] = [
      [empty, undefined],
      [covered, coveredCover],
      [wide, wideCover],
      [covered, coveredCover],
    ];
    const show = async ([item, cover]: (typeof selections)[number]) => {
      await grid.select([item]);
      await paneShows(
        grid,
        cover ? showsAttachment(cover) : showsEmptySection,
        `the cover of ${item.getDisplayTitle()}`,
      );
      if (cover) {
        const image = coverSection(grid.win)!.querySelector("img")!;
        await until(() => image.complete, "the cover image to load");
      }
      await painted(grid.win);
    };
    await show([wide, wideCover]);
    await show([covered, coveredCover]);

    const details = coverSection(grid.win)!.closest(
      "item-details",
    ) as ItemDetails;
    const scroller = details.querySelector<HTMLElement>(".zotero-view-item")!;
    const info = details.querySelector<HTMLElement>('[data-pane="info"]')!;
    const offset = () =>
      info.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    patch(details, "pinnedPane", "info");
    await details.scrollToPane("info", "instant");
    await painted(grid.win);
    const pinned = offset();

    for (let cycle = 0; cycle < 3; cycle++)
      for (const selection of selections) {
        await show(selection);
        assert.closeTo(
          offset(),
          pinned,
          2,
          `Info section moved, cycle ${cycle}, ${selection[0].getDisplayTitle()}`,
        );
      }
  });
});
