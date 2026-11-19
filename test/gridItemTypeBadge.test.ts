import { assert } from "chai";
import {
  clearPref,
  getPref,
  GridWindow,
  ItemSpec,
  openGrid,
  setPref,
  track,
  useTheme,
} from "./helpers/gridFixture";
import { imageBytes, scratchFile } from "./helpers/testEnvironment";

function localizedType(itemType: string): string {
  return Zotero.ItemTypes.getLocalizedString(itemType);
}

function attachment(
  contentType: string,
  linkMode: number,
  title: string,
): ItemSpec {
  return {
    itemType: "attachment",
    setup: (item) => {
      item.setField("title", title);
      item.attachmentLinkMode = linkMode;
      item.attachmentContentType = contentType;
    },
  };
}

/** Assert that the tile for `item` shows a badge labelled `itemType`. */
function assertBadge(view: GridWindow, item: Zotero.Item, itemType: string) {
  const badge = view.itemTypeBadge(item);
  const label = `${item.getDisplayTitle() || item.itemType}`;
  assert.exists(badge, `${label} has a badge`);
  assert.equal(badge!.label, localizedType(itemType), label);
  assert.equal(view.accessibleDescription(item), badge!.label, label);
  assert.isTrue(badge!.visible, `${label}: the badge is visible`);
  assert.isTrue(badge!.onCover, `${label}: the badge lies on the cover`);
  assert.notEqual(badge!.icon, "none", `${label}: the badge shows an icon`);
}

describe("item-type badge", function () {
  this.timeout(30000);

  it("is shown by default", function () {
    clearPref("showItemTypeIcon");
    assert.isTrue(getPref("showItemTypeIcon"));
  });

  it("labels a placeholder cover with the item's type", async function () {
    const grid = await openGrid({ items: 1 });
    const [item] = grid.items;
    assert.equal(grid.currentCover(item)?.kind, "placeholder");
    assertBadge(grid, item, "book");
  });

  it("distinguishes standalone notes and attachment kinds with Zotero's icons on attachment-derived and placeholder covers", async function () {
    const { LINK_MODE_IMPORTED_FILE, LINK_MODE_LINKED_FILE } =
      Zotero.Attachments;
    const { LINK_MODE_IMPORTED_URL, LINK_MODE_LINKED_URL } = Zotero.Attachments;
    const grid = await openGrid({
      items: [
        { itemType: "film" },
        { itemType: "journalArticle" },
        {
          itemType: "note",
          setup: (item) => item.setNote("<p>Standalone note</p>"),
        },
        attachment("application/pdf", LINK_MODE_IMPORTED_FILE, "PDF"),
        attachment("application/pdf", LINK_MODE_LINKED_FILE, "Linked PDF"),
        attachment("application/epub+zip", LINK_MODE_IMPORTED_FILE, "EPUB"),
        attachment(
          "application/epub+zip",
          LINK_MODE_LINKED_FILE,
          "Linked EPUB",
        ),
        attachment("text/html", LINK_MODE_IMPORTED_URL, "Snapshot"),
        attachment("text/html", LINK_MODE_LINKED_URL, "Web link"),
        attachment("video/mp4", LINK_MODE_IMPORTED_FILE, "Video"),
        attachment("application/octet-stream", LINK_MODE_IMPORTED_FILE, "File"),
        attachment(
          "application/octet-stream",
          LINK_MODE_LINKED_FILE,
          "Linked file",
        ),
      ],
    });
    const file = await scratchFile(
      "cover.png",
      imageBytes(240, 120, "image/png", { fill: "#eab24d" }),
    );
    const images = [
      await Zotero.Attachments.importFromFile({
        file,
        collections: [grid.collection.id],
      }),
      await Zotero.Attachments.linkFromFile({
        file,
        collections: [grid.collection.id],
      }),
    ];
    track(...images);
    await grid.showsItems(images);
    const items = [...grid.items, ...images];

    const variants = [
      ["light", 90],
      ["dark", 360],
    ] as const;
    for (const [theme, size] of variants) {
      await useTheme(theme);
      setPref("tileSize", size);
      await grid.settled();
      const icons = new Set<string>();
      for (const item of items) {
        await grid.reveal(item);
        assert.equal(
          grid.currentCover(item)?.kind,
          images.includes(item) ? "attachment" : "placeholder",
        );
        assertBadge(grid, item, item.itemType);
        icons.add(grid.itemTypeBadge(item)!.icon);
      }
      assert.equal(
        icons.size,
        items.length,
        `every kind has its own icon (${theme} theme, tile size ${size})`,
      );
    }
  });

  it("applies badge visibility live in a second main window, keeping covers, selection and focus", async function () {
    setPref("showItemTypeIcon", true);
    const grid = await openGrid({ items: 2 });
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

    for (const shown of [false, true]) {
      setPref("showItemTypeIcon", shown);
      for (const [index, view] of windows.entries()) {
        await view.settled();
        const label = `window ${index + 1}, badge ${shown ? "shown" : "hidden"}`;
        if (shown) assertBadge(view, item, "book");
        else {
          assert.notExists(view.itemTypeBadge(item), label);
          assert.equal(view.accessibleDescription(item), "", label);
        }
        assert.strictEqual(view.tile(item), tiles[index], label);
        assert.strictEqual(view.coverImage(item), covers[index], label);
        assert.deepEqual(view.selectedItems(), [item.id], label);
        assert.equal(view.focusedItem(), item.id, label);
      }
      assert.isTrue(grid.ownsFocus);
    }
  });
});
