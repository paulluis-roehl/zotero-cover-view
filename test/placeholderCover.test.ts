import { assert } from "chai";
import { createPlaceholderCoverURI } from "../src/modules/covers/placeholderCover";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import { registerCoverColumn } from "../src/modules/coverColumn";
import { getPref, setPref } from "../src/utils/prefs";

function svgFor(item: Zotero.Item): Document {
  const uri = createPlaceholderCoverURI(item);
  const win = Zotero.getMainWindow()!;
  return new win.DOMParser().parseFromString(
    decodeURIComponent(uri.slice(uri.indexOf(",") + 1)),
    "image/svg+xml",
  );
}

describe("placeholder families", function () {
  it("keeps wide-glyph titles and creators inside the readable text area", function () {
    const item = {
      itemType: "book",
      firstCreator: "WWWWWWWWWWWWWWWWWWWWWWWWWWWW",
      getDisplayTitle: () => "WWWWWWWWWWWWWWWWWW",
    } as Zotero.Item;
    const doc = Zotero.getMainWindow()!.document;
    const svg = doc.importNode(svgFor(item).documentElement, true);
    doc.documentElement.appendChild(svg);
    try {
      for (const text of svg.querySelectorAll("text")) {
        const bounds = (text as SVGGraphicsElement).getBBox();
        assert.isAtLeast(bounds.x, 67.5, "Text is not cut off on the left");
        assert.isAtMost(
          bounds.x + bounds.width,
          352.5,
          "Text is not cut off on the right",
        );
      }
    } finally {
      svg.remove();
    }
  });

  it("matches the cover frame's inner aspect ratio without side letterboxing", function () {
    const win = Zotero.getMainWindow()!;
    const addonDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "addon",
    );
    Object.defineProperty(globalThis, "addon", {
      configurable: true,
      value: Zotero.CoverView,
    });
    const host = win.document.createElement("div");
    host.style.cssText =
      "position:fixed;left:0;top:0;width:180px;--cover-view-tile-size:180px";
    win.document
      .getElementById("cover-view-grid")!
      .parentElement!.appendChild(host);
    const renderer = new GridRenderer(host, () => {});
    try {
      const item = new Zotero.Item("book");
      item.setField("title", "Frame geometry");
      renderer.setItems([item], {});
      const frame = host.querySelector<HTMLElement>(".grid-view-cover")!;
      for (const width of [120, 180, 300]) {
        frame.style.width = `${width}px`;
        const bounds = frame.getBoundingClientRect();
        const style = win.getComputedStyle(frame);
        const innerWidth =
          bounds.width -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth);
        const innerHeight =
          bounds.height -
          parseFloat(style.borderTopWidth) -
          parseFloat(style.borderBottomWidth);
        assert.closeTo(
          innerWidth / innerHeight,
          420 / 594,
          0.0001,
          `Frame ${bounds.width}×${bounds.height}, inner ${innerWidth}×${innerHeight}, ${style.boxSizing}`,
        );
      }
    } finally {
      renderer.destroy();
      host.remove();
      if (addonDescriptor)
        Object.defineProperty(globalThis, "addon", addonDescriptor);
      else Reflect.deleteProperty(globalThis, "addon");
    }
  });

  it("centers the year below the title and leaves generic covers text-only", function () {
    const item = new Zotero.Item("dataset");
    item.setField("title", "A title spanning several lines of text");
    item.setField("date", "2024");
    const svg = svgFor(item);
    const titleLines = Array.from(svg.querySelectorAll("tspan"));
    const lastLine = titleLines[titleLines.length - 1];
    const year = svg.querySelector('[data-metadata="year"]')!;
    assert.equal(year.getAttribute("text-anchor"), "middle");
    assert.equal(year.getAttribute("x"), lastLine.getAttribute("x"));
    assert.isAbove(
      Number(year.getAttribute("y")),
      Number(lastLine.getAttribute("y")),
    );
    assert.equal(
      svg.querySelector('[data-motif="generic"]')!.childElementCount,
      0,
    );
  });

  it("shares deterministic covers between grid and column independently of captions and grid decorations", async function () {
    const win = Zotero.getMainWindow()!;
    const register = Zotero.ItemTreeManager.registerColumns;
    const observer = win.IntersectionObserver;
    const addonDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "addon",
    );
    const keys = [
      "fetchISBNCover",
      "fetchMetadataCover",
      "desaturateOnlineCovers",
      "showItemTypeIcon",
    ] as const;
    const saved = keys.map(getPref);
    let visible: IntersectionObserverCallback | undefined;
    let column:
      | {
          dataProvider: (item: Zotero.Item, key: string) => string;
          renderCell: (
            index: number,
            data: string,
            column: { className: string },
            first: boolean,
            doc: Document,
          ) => HTMLElement;
        }
      | undefined;
    class Observer {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "200px") visible = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "addon", {
      configurable: true,
      value: Zotero.CoverView,
    });
    win.IntersectionObserver =
      Observer as unknown as typeof IntersectionObserver;
    Zotero.ItemTreeManager.registerColumns = (async (options: unknown) => {
      column = options as typeof column;
    }) as typeof register;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const items: Zotero.Item[] = [];
    try {
      setPref("fetchISBNCover", false);
      setPref("fetchMetadataCover", false);
      setPref("desaturateOnlineCovers", true);
      setPref("showItemTypeIcon", true);
      await registerCoverColumn();
      for (const type of [
        "book",
        "report",
        "audioRecording",
        "film",
        "artwork",
        "note",
        "dataset",
      ]) {
        const item = new Zotero.Item(type);
        items.push(item);
        if (type === "note") item.setNote("<p>Family recognition</p>");
        else {
          item.setField("title", "Family recognition");
          item.setField("date", "0044-03-15");
        }
        await item.saveTx();
        renderer.setItems([item], {
          showTitles: false,
          showCreators: false,
          showYears: false,
          showItemTypeIcon: true,
        });
        const tile = host.firstElementChild!;
        const image = tile.querySelector("img")!;
        assert.isFalse(
          image.hasAttribute("src"),
          "Offscreen covers remain lazy",
        );
        visible!(
          [{ isIntersecting: true, target: tile } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        const uri = await CoverProvider.getCover(item.id);
        const cell = column!.renderCell(
          0,
          column!.dataProvider(item, "cover"),
          { className: "cover" },
          false,
          win.document,
        );
        await Zotero.Promise.delay(0);
        assert.equal(image.src, uri);
        assert.equal(cell.querySelector("img")!.src, uri);
        assert.equal(
          uri,
          createPlaceholderCoverURI(item),
          "Output is deterministic",
        );
        assert.include(decodeURIComponent(uri!), "Family recognition");
        assert.notExists(tile.querySelector("figcaption"));
        assert.notExists(cell.querySelector(".grid-view-item-type-icon"));
        assert.equal(cell.querySelector("img")!.style.filter, "");
        renderer.setItems([item], {
          showTitles: true,
          showCreators: true,
          showYears: true,
        });
        assert.strictEqual(host.querySelector("img"), image);
        assert.equal(image.src, uri);
      }
    } finally {
      renderer.destroy();
      Zotero.ItemTreeManager.registerColumns = register;
      win.IntersectionObserver = observer;
      keys.forEach((key, index) => setPref(key, saved[index]));
      if (addonDescriptor)
        Object.defineProperty(globalThis, "addon", addonDescriptor);
      else Reflect.deleteProperty(globalThis, "addon");
      for (const item of items) if (item.id) await item.eraseTx();
      CoverProvider.clearCache();
    }
  });

  it("embeds normalized native years, suppressing unknown years", function () {
    for (const [date, year] of [
      ["May 12, 2020", "2020"],
      ["0044-03-15", "44"],
      ["0999-01-01", "999"],
      ["0000-05-12", ""],
      ["forthcoming", ""],
      ["", ""],
    ]) {
      const item = new Zotero.Item("book");
      item.setField("date", date);
      const svg = svgFor(item);
      assert.equal(
        svg.querySelector('[data-metadata="year"]')?.textContent ?? "",
        year,
        date,
      );
    }
  });

  it("maps standalone attachments by MIME type rather than filename or parent type", function () {
    for (const [contentType, family] of [
      ["image/png", "image"],
      ["image/svg+xml", "image"],
      ["audio/mpeg", "audio"],
      ["video/mp4", "video"],
      ["application/epub+zip", "book"],
      ["application/pdf", "document"],
      ["text/plain", "document"],
      ["text/html", "document"],
      ["application/octet-stream", "generic"],
      ["", "generic"],
      ["TEXT/PLAIN; charset=utf-8", "document"],
    ]) {
      const item = new Zotero.Item("attachment");
      item.attachmentContentType = contentType;
      assert.equal(
        svgFor(item).documentElement.getAttribute("data-family"),
        family,
        contentType,
      );
    }
  });

  it("maps every supported item type to its recognizable family, with a generic fallback", function () {
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
      generic: ["computerProgram", "dataset", "unknown", "futureType"],
    };
    const motifs = new Set<string>();
    for (const [family, types] of Object.entries(families)) {
      for (const itemType of types) {
        const item = {
          itemType,
          getDisplayTitle: () => "Shared title",
        } as Zotero.Item;
        const svg = svgFor(item);
        assert.equal(
          svg.documentElement.getAttribute("data-family"),
          family,
          itemType,
        );
        assert.equal(
          svg.documentElement.getAttribute("viewBox"),
          "0 0 420 594",
        );
        const motif = svg.querySelector(`[data-motif="${family}"]`)!;
        assert.exists(motif, `${family} has its own silhouette`);
        motifs.add(motif.innerHTML);
        assert.notExists(svg.querySelector("parsererror"));
      }
    }
    assert.equal(
      motifs.size,
      7,
      "Families differ by geometry, not only colour",
    );
  });

  it("gives a book a recognizable portrait silhouette and embedded metadata", async function () {
    const item = new Zotero.Item("book");
    item.setField("title", "Engine & Notes");
    item.setField("date", "1843");
    item.setCreators([
      { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
    ]);
    await item.saveTx();
    try {
      const svg = svgFor(item);
      assert.equal(svg.documentElement.getAttribute("data-family"), "book");
      assert.equal(svg.documentElement.getAttribute("viewBox"), "0 0 420 594");
      assert.include(svg.documentElement.textContent, "Engine & Notes");
      assert.include(svg.documentElement.textContent, "Lovelace");
      assert.include(svg.documentElement.textContent, "1843");
      assert.exists(svg.querySelector('[data-motif="book"] path'));
      assert.notExists(svg.querySelector("parsererror"));
    } finally {
      await item.eraseTx();
    }
  });
});
