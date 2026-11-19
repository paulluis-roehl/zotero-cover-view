import { assert } from "chai";
import {
  createGroup,
  focusWindow,
  GridFixture,
  ItemRef,
  openGrid,
  setPref,
  setTagColour,
  until,
} from "./helpers/gridFixture";

/** A tag name unique to this run, so its colour cannot clash. */
function tagName(label: string): string {
  return `${label} ${Zotero.Utilities.randomString(6)}`;
}

function tagged(...tags: string[]) {
  return {
    setup: (item: Zotero.Item) => item.setTags(tags.map((tag) => ({ tag }))),
  };
}

function shownNames(grid: GridFixture, item: ItemRef): string[] {
  return grid.tagIndicators(item).shown.map(({ name }) => name);
}

/** Wait until the tile for `item` shows indicators for exactly `names`. */
async function showsTags(
  grid: GridFixture,
  item: ItemRef,
  names: string[],
): Promise<void> {
  await until(
    () => JSON.stringify(shownNames(grid, item)) === JSON.stringify(names),
    `the tile to show the tags ${JSON.stringify(names)}`,
    { observe: () => grid.tagIndicators(item) },
  );
  await grid.settled();
}

function hasTag(items: Zotero.Item[], tag: string): boolean[] {
  return items.map((item) => item.hasTag(tag));
}

describe("tag indicators", function () {
  this.timeout(30000);

  beforeEach(function () {
    setPref("showTitles", true);
  });

  it("shows coloured and emoji tags before the title in Zotero's order, named after their tags", async function () {
    const [red, blue] = [tagName("Red"), tagName("Blue")];
    await setTagColour(blue, "#0000ff", 0);
    await setTagColour(red, "#ff0000", 1);
    const grid = await openGrid({
      items: [
        { title: "Tagged title", ...tagged(red, blue, "⭐ Read", "plain tag") },
      ],
    });
    const [item] = grid.items;

    const { shown, overflow } = grid.tagIndicators(item);
    assert.deepEqual(shownNames(grid, item), [blue, red, "⭐ Read"]);
    assert.exists(shown[0].colour);
    assert.exists(shown[1].colour);
    assert.notEqual(shown[0].colour, shown[1].colour, "colours differ");
    assert.equal(shown[2].emoji, "⭐");
    assert.notExists(overflow);
    assert.equal(grid.captionLines(item)[0].text, "Tagged title");
  });

  it("uses each library's tag colours and keeps coloured emoji tags as emoji", async function () {
    const coloured = tagName("Library colour");
    const reading = "📚 Reading";
    const group = await createGroup();
    await setTagColour(coloured, "#ff0000", 0);
    await setTagColour(coloured, "#0000ff", 0, group.libraryID);
    await setTagColour(reading, "#00ff00", 1, group.libraryID);

    const colours: string[] = [];
    for (const libraryID of [Zotero.Libraries.userLibraryID, group.libraryID]) {
      const grid = await openGrid({
        libraryID,
        items: [tagged(coloured, reading)],
      });
      const [item] = grid.items;
      const { shown } = grid.tagIndicators(item);
      assert.deepEqual(shownNames(grid, item), [coloured, reading]);
      assert.equal(shown[1].emoji, "📚");
      colours.push(shown[0].colour!);
    }
    assert.notEqual(colours[0], colours[1]);
  });

  it("collapses tags that do not fit into an overflow indicator naming them, and shows all of them in larger tiles", async function () {
    setPref("showCreators", false);
    setPref("showYears", false);
    setPref("tileSize", 90);
    const tags = [
      "⭐ First",
      "📚 Second",
      "✅ Third",
      "🔥 Fourth",
      "🎉 Fifth",
      "🌈 Sixth",
    ];
    const grid = await openGrid({
      items: [{ title: "Readable title space", ...tagged(...tags) }],
    });
    const [item] = grid.items;
    const tile = grid.tile(item);
    // Tags are fitted on resize observations, which need a painting window.
    focusWindow(grid.win);

    const { overflow } = await until(
      () => grid.tagIndicators(item).overflow && grid.tagIndicators(item),
      "some tags to be collapsed in the small tile",
      { observe: () => grid.tagIndicators(item) },
    );
    const collapsed = overflow!.names;
    assert.equal(overflow!.text, `+${collapsed.length}`);
    assert.sameMembers([...shownNames(grid, item), ...collapsed], tags);
    assert.lengthOf(grid.captionLines(item), 1, "tags take no extra line");
    const title = grid.captionText(item, "Readable title space");
    assert.isAtLeast(
      title.clientWidth,
      title.closest("figcaption")!.clientWidth / 2,
      "the title keeps at least half of its line",
    );

    setPref("tileSize", 360);
    await grid.settled();
    // Indicators are fitted to the caption once it has been resized.
    await until(
      () => !grid.tagIndicators(item).overflow,
      "all tags to fit the larger tile",
      { observe: () => grid.tagIndicators(item) },
    );
    assert.sameMembers(shownNames(grid, item), tags);
    assert.strictEqual(grid.tile(item), tile);
  });

  it("updates indicators live when tags and colours change, keeping the cover, selection and focused tile", async function () {
    const coloured = tagName("Live colour");
    const grid = await openGrid({ items: [{ title: "Live tags" }, {}] });
    const [item] = grid.items;
    grid.click(item);
    grid.focusGrid();
    await grid.settled();
    const tile = grid.tile(item);
    const cover = grid.coverImage(item);

    item.addTag("✅ Current");
    item.addTag(coloured);
    await item.saveTx();
    await showsTags(grid, item, ["✅ Current"]);

    await setTagColour(coloured, "#00ff00");
    await showsTags(grid, item, [coloured, "✅ Current"]);
    const green = grid.tagIndicators(item).shown[0].colour;
    await setTagColour(coloured, "#ff0000");
    await until(
      () => grid.tagIndicators(item).shown[0].colour !== green,
      "the indicator to show the changed colour",
      { observe: () => grid.tagIndicators(item) },
    );

    setPref("showTitles", false);
    await grid.settled();
    assert.isEmpty(grid.tagIndicators(item).shown, "no title, no indicators");
    item.removeTag("✅ Current");
    await item.saveTx();
    setPref("showTitles", true);
    await showsTags(grid, item, [coloured]);

    assert.strictEqual(grid.tile(item), tile);
    assert.strictEqual(grid.coverImage(item), cover);
    assert.deepEqual(grid.selectedItems(), [item.id]);
    assert.equal(grid.focusedItem(), item.id);
    assert.isTrue(grid.ownsFocus);
  });

  it("shows current indicators on tiles that are scrolled into view later", async function () {
    const grid = await openGrid({ items: 121 });
    const last = grid.itemByID(grid.displayedItems().at(-1)!);
    assert.notExists(grid.findTile(last), "the last tile starts unmounted");

    last.addTag("🔥 Current");
    await last.saveTx();
    await grid.settled();
    grid.focusGrid();
    grid.press("End");
    await grid.settled();
    assert.isTrue(grid.isVisible(last));
    await showsTags(grid, last, ["🔥 Current"]);
  });

  describe("tag shortcuts", function () {
    let one: string;
    let two: string;

    beforeEach(async function () {
      [one, two] = [tagName("First"), tagName("Second")];
      await setTagColour(one, "#ff6666", 0);
      await setTagColour(two, "#2ea8e5", 1);
    });

    async function untilTagged(
      items: Zotero.Item[],
      tag: string,
      expected: boolean,
    ): Promise<void> {
      await until(
        () => items.every((item) => item.hasTag(tag) === expected),
        `${tag} to be ${expected ? "added to" : "removed from"} the selected items`,
        { observe: () => hasTag(items, tag) },
      );
    }

    it("toggles coloured tags on the selected items with number keys, and removes them all with 0", async function () {
      const grid = await openGrid({ items: 2 });
      const items = grid.items;
      await grid.select(items);
      grid.focusGrid();

      grid.press("1", { code: "Digit1" });
      await untilTagged(items, one, true);
      grid.press("1", { code: "Digit1" });
      await untilTagged(items, one, false);

      grid.press("2", { code: "Digit2" });
      await untilTagged(items, two, true);
      grid.press("1", { code: "Digit1" });
      await untilTagged(items, one, true);
      await showsTags(grid, items[0], [one, two]);

      grid.press("0", { code: "Digit0" });
      await untilTagged(items, one, false);
      await untilTagged(items, two, false);
      assert.sameMembers(
        grid.selectedItems(),
        items.map((item) => item.id),
      );
    });

    it("toggles tags with numpad digits and their navigation keys, keeping the focused tile", async function () {
      const grid = await openGrid({ items: 3 });
      const middle = grid.itemByID(grid.displayedItems()[1]);
      await grid.select([middle]);
      grid.focusGrid();

      grid.press("1", { code: "Numpad1" });
      await untilTagged([middle], one, true);
      // With NumLock off, numpad keys report navigation keys.
      grid.press("End", { code: "Numpad1" });
      await untilTagged([middle], one, false);
      grid.press("ArrowDown", { code: "Numpad2" });
      await untilTagged([middle], two, true);
      grid.press("Insert", { code: "Numpad0" });
      await untilTagged([middle], two, false);
      // Numpad keys without a coloured tag do not navigate either.
      grid.press("PageDown", { code: "Numpad3" });
      grid.press("Home", { code: "Numpad7" });
      await grid.settled();

      assert.deepEqual(grid.selectedItems(), [middle.id]);
      assert.equal(grid.focusedItem(), middle.id);
    });

    it("applies a number key to a tile clicked just before", async function () {
      const grid = await openGrid({ items: 2 });
      const [first, second] = grid.items;
      await grid.select([first]);
      grid.focusGrid();

      grid.click(second);
      grid.press("1", { code: "Digit1" });
      await untilTagged([second], one, true);
      await grid.settled();
      assert.isFalse(first.hasTag(one));
    });

    it("leaves number keys with modifiers to Zotero", async function () {
      const grid = await openGrid({ items: 1 });
      const [item] = grid.items;
      await grid.select([item]);
      grid.focusGrid();

      for (const modifiers of [
        { shift: true },
        { ctrl: true },
        { meta: true },
        { alt: true },
      ])
        grid.press("1", { code: "Digit1", ...modifiers });
      // A later unmodified shortcut takes effect after any earlier one.
      grid.press("2", { code: "Digit2" });
      await untilTagged([item], two, true);
      await grid.settled();
      assert.isFalse(item.hasTag(one));
    });
  });
});
