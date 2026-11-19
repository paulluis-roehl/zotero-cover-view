import { assert } from "chai";
import {
  CaptionLine,
  clearPref,
  getPref,
  GridWindow,
  ItemSpec,
  openGrid,
  setPref,
} from "./helpers/gridFixture";

const TITLE = "The Brass Orrery of Quillmere";

/** A book by Odile Penhallow, published in 1843. */
const book: ItemSpec = {
  title: TITLE,
  setup: (item) => {
    item.setField("date", "1843-08-01");
    item.setCreators([
      { firstName: "Odile", lastName: "Penhallow", creatorType: "author" },
    ]);
  },
};

type CaptionPrefs = Record<
  "showTitles" | "showCreators" | "showYears",
  boolean
>;

function setCaptionPrefs(prefs: CaptionPrefs): void {
  for (const [key, value] of Object.entries(prefs))
    setPref(key as keyof CaptionPrefs, value);
}

/** The metadata line of `book` under `prefs`. */
function metadata({ showCreators, showYears }: CaptionPrefs): string {
  return [showCreators && "Penhallow", showYears && "1843"]
    .filter(Boolean)
    .join(" · ");
}

/** The caption of `book` under `prefs`. */
function expectedCaption(prefs: CaptionPrefs): CaptionLine[] {
  const lines = prefs.showTitles ? [TITLE] : [];
  if (metadata(prefs)) lines.push(metadata(prefs));
  return lines.map((text) => ({ text, tooltip: text }));
}

function isTruncated(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth;
}

const ALL_ON: CaptionPrefs = {
  showTitles: true,
  showCreators: true,
  showYears: true,
};

describe("tile captions", function () {
  this.timeout(30000);

  it("shows the title, creator caption and year caption by default", function () {
    for (const key of Object.keys(ALL_ON) as (keyof CaptionPrefs)[]) {
      clearPref(key);
      assert.isTrue(getPref(key), key);
    }
  });

  it("shows the title, creator caption and year caption independently", async function () {
    const grid = await openGrid({ items: [book] });
    const [item] = grid.items;
    for (const showTitles of [true, false])
      for (const showCreators of [true, false])
        for (const showYears of [true, false]) {
          const prefs = { showTitles, showCreators, showYears };
          setCaptionPrefs(prefs);
          await grid.settled();
          const label = JSON.stringify(prefs);
          assert.deepEqual(
            grid.captionLines(item),
            expectedCaption(prefs),
            label,
          );
          assert.equal(
            grid.accessibleName(item),
            [TITLE, metadata(prefs)].filter(Boolean).join(" · "),
            label,
          );
          assert.equal(grid.coverImage(item).alt, `Cover for ${TITLE}`);
        }
  });

  it("omits missing caption fields and shows Zotero's year, including early and unknown years", async function () {
    const dates = [
      ["2020-05-12", "2020"],
      ["May 12, 2020", "2020"],
      ["0044-03-15", "44"],
      ["0999-01-01", "999"],
      ["0000-05-12", ""],
      ["forthcoming", ""],
      ["", ""],
    ];
    setCaptionPrefs(ALL_ON);
    const grid = await openGrid({
      items: [
        ...dates.map(([date]): ItemSpec => ({
          title: "",
          setup: (item) => item.setField("date", date),
        })),
        { title: "Title only" },
      ],
    });
    for (const [index, [date, year]] of dates.entries()) {
      await grid.reveal(grid.items[index]);
      assert.deepEqual(
        grid.captionLines(grid.items[index]),
        year ? [{ text: year, tooltip: year }] : [],
        date,
      );
    }
    await grid.reveal(grid.items.at(-1)!);
    assert.deepEqual(grid.captionLines(grid.items.at(-1)!), [
      { text: "Title only", tooltip: "Title only" },
    ]);
  });

  it("summarises primary creators as Zotero does, including directors, artists and editors", async function () {
    setCaptionPrefs(ALL_ON);
    const creators = [
      ["film", "director", "Thistlewood"],
      ["artwork", "artist", "Marrowby"],
      ["book", "editor", "Quist"],
    ] as const;
    const grid = await openGrid({
      items: creators.map(([itemType, creatorType, lastName]) => ({
        itemType,
        setup: (item) => item.setCreators([{ lastName, creatorType }]),
      })),
    });
    for (const [index, [, role, name]] of creators.entries()) {
      const item = grid.items[index];
      assert.equal(item.firstCreator, name, role);
      assert.deepEqual(grid.captionLines(item)[1], {
        text: name,
        tooltip: name,
      });
    }
  });

  it("keeps a long creator caption and the full year caption on one line in small tiles", async function () {
    setCaptionPrefs(ALL_ON);
    setPref("tileSize", 90);
    const grid = await openGrid({
      items: [
        {
          setup: (item) => {
            item.setField("date", "2024");
            item.setCreators([
              {
                lastName:
                  "The Very Long Institutional Society of Weathervane Cartographers",
                fieldMode: 1,
                creatorType: "author",
              },
            ]);
          },
        },
      ],
    });
    const [item] = grid.items;
    const creator = grid.captionText(item, item.firstCreator);
    const year = grid.captionText(item, "2024");
    assert.closeTo(
      creator.getBoundingClientRect().top,
      year.getBoundingClientRect().top,
      1,
      "creator and year share a line",
    );
    assert.isTrue(isTruncated(creator), "the creator caption is cut off");
    assert.isFalse(isTruncated(year), "the year caption is fully readable");
    assert.equal(
      grid.captionLines(item)[1].tooltip,
      `${item.firstCreator} · 2024`,
    );
  });

  it("keeps the cover, selection and focused tile when captions change", async function () {
    setCaptionPrefs(ALL_ON);
    const grid = await openGrid({ items: [book, {}] });
    const [item] = grid.items;
    grid.click(item);
    await grid.settled();
    const tile = grid.tile(item);
    const cover = grid.coverImage(item);
    const source = cover.src;

    setCaptionPrefs({
      showTitles: false,
      showCreators: false,
      showYears: false,
    });
    await grid.settled();
    assert.isEmpty(grid.captionLines(item));
    assert.equal(grid.accessibleName(item), TITLE);
    assert.strictEqual(grid.tile(item), tile);
    assert.strictEqual(grid.coverImage(item), cover);
    assert.equal(cover.src, source);
    assert.deepEqual(grid.selectedItems(), [item.id]);
    assert.equal(grid.focusedItem(), item.id);
  });

  it("applies caption changes made while the native item tree is shown", async function () {
    setCaptionPrefs(ALL_ON);
    const grid = await openGrid({ items: [book] });
    const [item] = grid.items;
    await grid.select([item]);
    const tile = grid.tile(item);

    await grid.showList();
    setPref("showCreators", false);
    await grid.showGrid();
    assert.deepEqual(
      grid.captionLines(item),
      expectedCaption({ ...ALL_ON, showCreators: false }),
    );
    assert.strictEqual(grid.tile(item), tile);
    assert.deepEqual(grid.presentedSelection(), [item.id]);
  });

  it("applies caption changes live in a second main window without disturbing selection or navigation", async function () {
    setCaptionPrefs(ALL_ON);
    const grid = await openGrid({ items: [book, book] });
    const [item] = grid.items;
    const second = await grid.openWindow();
    const windows: GridWindow[] = [grid, second];
    for (const view of windows) {
      view.click(item);
      await view.settled();
    }
    grid.focusGrid();
    const tiles = windows.map((view) => view.tile(item));
    const covers = windows.map((view) => view.coverImage(item));

    for (const key of Object.keys(ALL_ON) as (keyof CaptionPrefs)[]) {
      for (const shown of [false, true]) {
        const prefs = { ...ALL_ON, [key]: shown };
        setPref(key, shown);
        for (const [index, view] of windows.entries()) {
          await view.settled();
          assert.deepEqual(
            view.captionLines(item),
            expectedCaption(prefs),
            `window ${index + 1}, ${JSON.stringify(prefs)}`,
          );
        }
      }
    }
    for (const [index, view] of windows.entries()) {
      assert.strictEqual(view.tile(item), tiles[index]);
      assert.strictEqual(view.coverImage(item), covers[index]);
      assert.deepEqual(view.selectedItems(), [item.id]);
      assert.equal(view.focusedItem(), item.id);
    }

    const [first, next] = grid.displayedItems();
    await grid.select([first]);
    grid.press("ArrowRight");
    await grid.settled();
    assert.deepEqual(grid.selectedItems(), [next]);
  });
});
