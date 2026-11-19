import { assert } from "chai";
import { createPlaceholderCoverURI } from "../src/modules/covers/placeholderCover";
import { createItems, createRenderer, onTeardown } from "./helpers/gridFixture";

const families = {
  book: ["book", "bookSection", "dictionaryEntry", "encyclopediaArticle"],
  audio: ["audioRecording", "podcast", "radioBroadcast"],
  video: ["film", "tvBroadcast", "videoRecording"],
  image: ["artwork", "map"],
  note: ["note"],
  document: [
    "bill",
    "blogPost",
    "case",
    "conferencePaper",
    "email",
    "forumPost",
    "hearing",
    "instantMessage",
    "interview",
    "journalArticle",
    "letter",
    "magazineArticle",
    "manuscript",
    "newspaperArticle",
    "patent",
    "preprint",
    "presentation",
    "report",
    "standard",
    "statute",
    "thesis",
    "webpage",
  ],
  generic: ["computerProgram", "dataset"],
};

// Short enough for one line.
const TITLE = "Tidewright Ledger";

/** An unsaved item of `itemType` titled `title`, without creator or date. */
function itemOfType(itemType: string, title = TITLE): Zotero.Item {
  const item = new Zotero.Item(
    itemType as unknown as keyof _ZoteroTypes.Item.ItemTypeMapping,
  );
  if (itemType === "note") item.setNote(`<p>${title}</p>`);
  else item.setField("title", title);
  return item;
}

/** An unsaved standalone attachment of `contentType` titled `title`. */
function attachmentOf(contentType: string, title = TITLE): Zotero.Item {
  const item = new Zotero.Item("attachment");
  item.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
  item.attachmentContentType = contentType;
  item.setField("title", title);
  return item;
}

function parse(uri: string): Document {
  return new (Zotero.getMainWindow()!.DOMParser)().parseFromString(
    decodeURIComponent(uri.slice(uri.indexOf(",") + 1)),
    "image/svg+xml",
  );
}

/** The lines of text of a placeholder cover. */
function lines(cover: ParentNode): SVGTextElement[] {
  return Array.from(
    cover.querySelectorAll("text"),
  ) as unknown as SVGTextElement[];
}

/** The text the placeholder cover of `item` shows, line by line. */
function coverText(item: Zotero.Item): string[] {
  return lines(parse(createPlaceholderCoverURI(item))).map(
    (text) => text.textContent ?? "",
  );
}

/**
 * The placeholder cover of `item`, laid out in the main window until the
 * current test ends.
 */
function laidOutCover(item: Zotero.Item): Element {
  const doc = Zotero.getMainWindow()!.document;
  const svg = doc.importNode(
    parse(createPlaceholderCoverURI(item)).documentElement!,
    true,
  ) as Element;
  doc.documentElement!.append(svg);
  onTeardown(() => svg.remove());
  return svg;
}

function textElement(svg: Element, text: string): SVGTextElement {
  const found = lines(svg).filter((element) => element.textContent === text);
  assert.lengthOf(found, 1, `one line reads "${text}"`);
  return found[0];
}

/** The ratio of the width to the height an image of `uri` is shown at. */
async function shownRatio(uri: string): Promise<number> {
  const doc = Zotero.getMainWindow()!.document;
  const image = doc.createElement("img");
  image.style.cssText = "position:fixed;width:200px";
  image.src = uri;
  doc.documentElement!.append(image);
  onTeardown(() => image.remove());
  await image.decode();
  const { width, height } = image.getBoundingClientRect();
  return width / height;
}

describe("placeholder cover", function () {
  describe("family", function () {
    it("is the same for all item types of a family and differs between families", function () {
      const representatives = new Set<string>();
      for (const [family, types] of Object.entries(families)) {
        const representative = createPlaceholderCoverURI(itemOfType(types[0]));
        representatives.add(representative);
        for (const itemType of types.slice(1))
          assert.equal(
            createPlaceholderCoverURI(itemOfType(itemType)),
            representative,
            `${itemType} looks like a ${family}`,
          );
      }
      assert.equal(
        representatives.size,
        Object.keys(families).length,
        "each family looks different",
      );
    });

    it("is generic for item types without a family", function () {
      const generic = createPlaceholderCoverURI(itemOfType("dataset"));
      const unknown = {
        itemType: "futureType",
        getDisplayTitle: () => TITLE,
      } as unknown as Zotero.Item;
      assert.equal(createPlaceholderCoverURI(unknown), generic);
    });

    it("is chosen for a standalone attachment by its content type", function () {
      for (const [contentType, itemType] of [
        ["image/png", "artwork"],
        ["image/svg+xml", "artwork"],
        ["audio/mpeg", "audioRecording"],
        ["video/mp4", "film"],
        ["application/epub+zip", "book"],
        ["application/pdf", "report"],
        ["text/plain", "report"],
        ["text/html", "report"],
        ["TEXT/PLAIN; charset=utf-8", "report"],
        ["application/octet-stream", "dataset"],
        ["", "dataset"],
      ])
        assert.equal(
          createPlaceholderCoverURI(attachmentOf(contentType)),
          createPlaceholderCoverURI(itemOfType(itemType)),
          `${contentType || "no content type"} looks like ${itemType}`,
        );
    });
  });

  describe("text", function () {
    it("shows the item's title, first creator and year", async function () {
      const [item] = await createItems([
        {
          title: "Engines & Notes",
          setup: (item) => {
            item.setCreators([
              {
                firstName: "Odile",
                lastName: "Penhallow",
                creatorType: "author",
              },
            ]);
            item.setField("date", "1843");
          },
        },
      ]);
      assert.sameMembers(coverText(item), [
        "Engines & Notes",
        "Penhallow",
        "1843",
      ]);
    });

    it("shows the year as Zotero's Year column does, and no unknown year", function () {
      for (const [date, year] of [
        ["May 12, 2020", "2020"],
        ["0044-03-15", "44"],
        ["0999-01-01", "999"],
        ["0000-05-12", undefined],
        ["forthcoming", undefined],
        ["", undefined],
      ] as const) {
        const item = itemOfType("book");
        item.setField("date", date);
        assert.sameMembers(
          coverText(item),
          year ? [TITLE, year] : [TITLE],
          date || "no date",
        );
      }
    });

    it("is the same for the same item and changes with the title", async function () {
      const [item] = await createItems([{ title: TITLE }]);
      const cover = createPlaceholderCoverURI(item);
      assert.equal(createPlaceholderCoverURI(item), cover);
      item.setField("title", "Quillmere Lanterns");
      await item.saveTx();
      assert.notEqual(createPlaceholderCoverURI(item), cover);
    });

    it("shows the year centred below the title", function () {
      const item = itemOfType(
        "dataset",
        "A title spanning several lines of text",
      );
      item.setField("date", "2024");
      const svg = laidOutCover(item);
      const title = lines(svg)
        .filter((text) => text.textContent !== "2024")
        .map((text) => text.getBBox());
      assert.isAbove(title.length, 1, "the title wraps");
      const lastLine = title.reduce((lowest, line) =>
        line.y > lowest.y ? line : lowest,
      );
      const year = textElement(svg, "2024").getBBox();
      assert.isAtLeast(year.y, lastLine.y + lastLine.height, "year below");
      assert.closeTo(
        year.x + year.width / 2,
        lastLine.x + lastLine.width / 2,
        lastLine.width * 0.05,
        "year centred",
      );
    });

    it("keeps titles and creators of wide letters within the readable area", function () {
      const item = {
        itemType: "book",
        firstCreator: "WWWWWWWWWWWWWWWWWWWWWWWWWWWW",
        getDisplayTitle: () => "WWWWWWWWWWWWWWWWWW",
      } as unknown as Zotero.Item;
      const svg = laidOutCover(item);
      // Text is clipped to the readable area.
      const area = svg.querySelector(
        "clipPath > rect",
      ) as unknown as SVGRectElement;
      const readable = {
        x: area.x.baseVal.value,
        width: area.width.baseVal.value,
      };
      const texts = lines(svg);
      assert.isNotEmpty(texts);
      for (const text of texts) {
        const bounds = text.getBBox();
        assert.isAtLeast(bounds.x, readable.x, "not cut off on the left");
        assert.isAtMost(
          bounds.x + bounds.width,
          readable.x + readable.width,
          "not cut off on the right",
        );
      }
    });
  });

  it("fills the cover frame of a tile without letterboxing", async function () {
    const grid = createRenderer({ items: 1 });
    const [item] = grid.items;
    const ratio = await shownRatio(createPlaceholderCoverURI(item));
    for (const tileSize of [120, 180, 300]) {
      grid.resize({ tileSize });
      const frame = grid.coverImage(item).parentElement!;
      assert.closeTo(
        frame.clientWidth / frame.clientHeight,
        ratio,
        0.01,
        `tile size ${tileSize}`,
      );
    }
  });
});
