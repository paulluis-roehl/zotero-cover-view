import { assert } from "chai";
import {
  clearPref,
  Colour,
  focusWindow,
  getPref,
  GridFixture,
  GridWindow,
  onTeardown,
  openGrid,
  setPref,
  track,
  until,
  useTheme,
} from "./helpers/gridFixture";
import {
  imageBytes,
  interceptOpenLibrary,
  scratchFile,
  uniqueEditionKey,
  uniqueISBN,
} from "./helpers/testEnvironment";

/** Two-tone cover image, used for both online and attachment covers. */
function coverBytes(): Uint8Array {
  return imageBytes(120, 120, "image/jpeg", {
    fill: "#dc315d",
    lowerFill: "#367dcc",
  });
}

function difference(a: Colour, b: Colour): number {
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
}

/** Clearly different to the eye. */
function assertDistinct(a: Colour, b: Colour, message: string): void {
  assert.isAbove(difference(a, b), 20, message);
}

/** Indistinguishable to the eye. */
function assertAlike(a: Colour, b: Colour, message: string): void {
  assert.isBelow(difference(a, b), 5, message);
}

async function showsCover(
  view: GridWindow,
  item: Zotero.Item,
  kind: "online" | "attachment" | "placeholder",
): Promise<void> {
  await until(
    () => view.currentCover(item)?.kind === kind,
    `the tile to show a ${kind} cover`,
    { observe: () => view.currentCover(item) },
  );
}

async function attachCover(parent: Zotero.Item): Promise<Zotero.Item> {
  const file = await scratchFile("cover.jpg", coverBytes());
  const [child] = track(
    await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id }),
  );
  return child;
}

/**
 * A grid of small tiles, all in view: a book with an online-sourced cover
 * found by ISBN, one found by title and creator, a book with an
 * attachment-derived cover of the same image, and a book with a placeholder
 * cover.
 */
async function openCoverGrid(): Promise<{
  grid: GridFixture;
  online: Zotero.Item;
  found: Zotero.Item;
  attached: Zotero.Item;
  placeholder: Zotero.Item;
}> {
  setPref("fetchISBNCover", true);
  setPref("fetchMetadataCover", true);
  setPref("tileSize", 90);
  const bytes = coverBytes();
  const edition = uniqueEditionKey();
  const marker = Zotero.Utilities.randomString();
  // Only the book titled with `marker` has a cover to find by title.
  interceptOpenLibrary((url) =>
    url.includes("search.json")
      ? {
          json: {
            docs: url.includes(marker) ? [{ cover_edition_key: edition }] : [],
          },
        }
      : { bytes },
  );
  const grid = await openGrid({
    items: [
      { setup: (item) => item.setField("ISBN", uniqueISBN()) },
      {
        title: `Found cover ${marker}`,
        setup: (item) =>
          item.setCreators([{ lastName: "Ashgrove", creatorType: "author" }]),
      },
      {},
      {},
    ],
  });
  const [online, found, attached, placeholder] = grid.items;
  await attachCover(attached);
  await showsCover(grid, attached, "attachment");
  await showsCover(grid, found, "online");
  await grid.settled();
  assert.equal(grid.currentCover(online)?.kind, "online");
  assert.equal(grid.currentCover(placeholder)?.kind, "placeholder");
  // Covers are compared as painted, which needs a painting window.
  focusWindow(grid.win);
  return { grid, online, found, attached, placeholder };
}

async function setOnlineCoversApart(views: GridWindow[], apart: boolean) {
  setPref("desaturateOnlineCovers", apart);
  for (const view of views) await view.settled();
}

describe("online-sourced covers", function () {
  this.timeout(30000);

  it("are not set apart by default", function () {
    clearPref("desaturateOnlineCovers");
    assert.isFalse(getPref("desaturateOnlineCovers"));
  });

  for (const theme of ["light", "dark"] as const)
    it(`are visibly set apart from attachment-derived covers when enabled, in the ${theme} theme`, async function () {
      await useTheme(theme);
      const { grid, online, found, attached, placeholder } =
        await openCoverGrid();
      const sources = { "by ISBN": online, "by title and creator": found };

      await setOnlineCoversApart([grid], false);
      const plain = grid.paintedCover(placeholder);
      for (const [source, item] of Object.entries(sources))
        assertAlike(
          grid.paintedCover(item),
          grid.paintedCover(attached),
          `covers found ${source} look like attachment covers when disabled`,
        );

      await setOnlineCoversApart([grid], true);
      for (const [source, item] of Object.entries(sources))
        assertDistinct(
          grid.paintedCover(item),
          grid.paintedCover(attached),
          `covers found ${source} look different when enabled`,
        );
      assertAlike(
        grid.paintedCover(placeholder),
        plain,
        "placeholder covers are not set apart",
      );
    });

  it("applies the preference live in a second main window, keeping covers, selection and focus", async function () {
    const { grid, online, attached, placeholder } = await openCoverGrid();
    const second = await grid.openWindow();
    const windows = [grid, second];
    for (const view of windows) {
      view.click(placeholder);
      await view.settled();
    }
    grid.focusGrid();
    const covers = windows.map((view) => view.coverImage(online));

    for (const enabled of [true, false]) {
      await setOnlineCoversApart(windows, enabled);
      for (const [index, view] of windows.entries()) {
        const label = `window ${index + 1}, ${enabled ? "enabled" : "disabled"}`;
        const compare = enabled ? assertDistinct : assertAlike;
        compare(view.paintedCover(online), view.paintedCover(attached), label);
        assert.strictEqual(view.coverImage(online), covers[index], label);
        assert.deepEqual(view.selectedItems(), [placeholder.id], label);
        assert.equal(view.focusedItem(), placeholder.id, label);
      }
      assert.isTrue(grid.ownsFocus);
    }
  });

  it("are set apart only while the current cover is online-sourced", async function () {
    const { grid, online, attached } = await openCoverGrid();
    await setOnlineCoversApart([grid], true);

    const child = await attachCover(online);
    await showsCover(grid, online, "attachment");
    await grid.settled();
    assertAlike(
      grid.paintedCover(online),
      grid.paintedCover(attached),
      "an attachment-derived cover is not set apart",
    );

    await child.eraseTx();
    await showsCover(grid, online, "online");
    await grid.settled();
    assertDistinct(
      grid.paintedCover(online),
      grid.paintedCover(attached),
      "the online-sourced cover is set apart again",
    );

    online.setField("ISBN", "");
    await online.saveTx();
    await showsCover(grid, online, "placeholder");
    await grid.settled();
    const apart = grid.paintedCover(online);
    await setOnlineCoversApart([grid], false);
    assertAlike(
      apart,
      grid.paintedCover(online),
      "a placeholder cover is not set apart",
    );
  });

  it("are not applied to a newer attachment-derived cover when an earlier online lookup finishes late", async function () {
    setPref("fetchISBNCover", true);
    setPref("fetchMetadataCover", false);
    setPref("desaturateOnlineCovers", true);
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    focusWindow(grid.win);
    const bytes = coverBytes();
    let release: (() => void) | undefined;
    let replied: Promise<unknown> | undefined;
    interceptOpenLibrary(() => {
      replied = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => ({ bytes }));
      return replied as Promise<{ bytes: Uint8Array }>;
    });
    onTeardown(() => release?.());

    item.setField("ISBN", uniqueISBN());
    await item.saveTx();
    await until(() => release, "the online lookup to start");
    // The preference can change while the lookup is pending.
    setPref("desaturateOnlineCovers", false);
    setPref("desaturateOnlineCovers", true);
    await attachCover(item);
    await showsCover(grid, item, "attachment");
    const image = grid.coverImage(item);

    release!();
    await replied;
    await grid.settled();
    assert.equal(grid.currentCover(item)?.kind, "attachment");
    assert.strictEqual(grid.coverImage(item), image);
    const apart = grid.paintedCover(item);
    await setOnlineCoversApart([grid], false);
    assertAlike(
      apart,
      grid.paintedCover(item),
      "the attachment-derived cover is not set apart",
    );
  });
});
