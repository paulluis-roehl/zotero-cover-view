import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";

type ItemDetails = HTMLElement & {
  pinnedPane: string;
  scrollToPane: (id: string, behavior: string) => Promise<void>;
};

async function settleLayout(win: Window): Promise<void> {
  await new Promise<void>((resolve) =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())),
  );
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(condition(), "Item Pane cover did not update");
}

describe("library Item Pane cover", function () {
  this.timeout(20000);
  const keys = [
    "enableGridView",
    "fetchISBNCover",
    "fetchMetadataCover",
  ] as const;
  let saved: boolean[];
  let win: _ZoteroTypes.MainWindow;
  let directory: string;
  let file: string;
  let jpeg: Uint8Array;
  let items: Zotero.Item[];

  const section = () =>
    win.document.querySelector<HTMLElement>(
      "#zotero-item-pane item-pane-custom-section:has(.cover-view-item-pane-image)",
    );
  const image = () =>
    section()?.querySelector<HTMLImageElement>(".cover-view-item-pane-image");
  const shows = (item: Zotero.Item) =>
    !!section() && !section()!.hidden && !!image()?.src.includes(item.key);

  beforeEach(async function () {
    win = Zotero.getMainWindow()!;
    saved = keys.map(getPref);
    keys.forEach((key) => setPref(key, false));
    items = [];
    directory = `/tmp/opencode/item-pane-${Zotero.Utilities.randomString()}`;
    file = PathUtils.join(directory, "cover.png");
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    await writeCover(40, 60);
  });

  async function writeCover(width: number, height: number): Promise<void> {
    const canvas = win.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.fillRect(0, 0, width, height);
    jpeg = Uint8Array.from(
      win.atob(canvas.toDataURL("image/jpeg").split(",")[1]),
      (c) => c.charCodeAt(0),
    );
    await IOUtils.write(
      file,
      Uint8Array.from(win.atob(canvas.toDataURL().split(",")[1]), (c) =>
        c.charCodeAt(0),
      ),
    );
  }

  afterEach(async function () {
    for (const item of items.reverse()) if (item.id) await item.eraseTx();
    keys.forEach((key, index) => setPref(key, saved[index]));
    await IOUtils.remove(file, { ignoreAbsent: true });
    await IOUtils.remove(directory, { ignoreAbsent: true });
  });

  async function book(): Promise<Zotero.Item> {
    const item = new Zotero.Item("book");
    item.setField("title", "Item Pane cover test");
    await item.saveTx();
    items.push(item);
    return item;
  }

  async function attach(parent?: Zotero.Item): Promise<Zotero.Item> {
    const item = await Zotero.Attachments.importFromFile({
      file,
      parentItemID: parent?.id,
    });
    if (!parent) items.push(item);
    return item;
  }

  it("shows the current real cover in the native library Item Pane", async function () {
    const item = await book();
    const attachment = await attach(item);
    await win.ZoteroPane.selectItems([item.id], true);
    await waitFor(() => shows(attachment));
    await waitFor(() => image()!.complete && image()!.naturalWidth > 0);
    assert.isAbove(image()!.naturalWidth, 0);
  });

  it("retains pinned section alignment across repeated real and placeholder cover switches", async function () {
    const covered = await book();
    const attachment = await attach(covered);
    const empty = await book();
    const wide = await book();
    await writeCover(120, 40);
    const wideAttachment = await attach(wide);
    await win.ZoteroPane.selectItems([wide.id], true);
    await waitFor(() => shows(wideAttachment) && image()!.complete);
    await settleLayout(win);
    await win.ZoteroPane.selectItems([covered.id], true);
    await waitFor(() => shows(attachment) && image()!.complete);
    await settleLayout(win);
    const details = section()!.closest("item-details")! as ItemDetails;
    const previous = details.pinnedPane;
    const scroller = details.querySelector<HTMLElement>(".zotero-view-item")!;
    const info = details.querySelector<HTMLElement>('[data-pane="info"]')!;
    const alignment = () =>
      info.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    try {
      details.pinnedPane = "info";
      await details.scrollToPane("info", "instant");
      assert.closeTo(alignment(), 0, 2, "initial pinned Info alignment");
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const [item, cover] of [
          [empty, undefined],
          [covered, attachment],
          [wide, wideAttachment],
          [covered, attachment],
        ] as const) {
          await win.ZoteroPane.selectItems([item.id], true);
          await waitFor(() =>
            cover ? shows(cover) && image()!.complete : image()!.hidden,
          );
          await settleLayout(win);
          assert.closeTo(
            alignment(),
            0,
            2,
            `pinned Info alignment, cycle ${cycle}, item ${item.id}`,
          );
        }
      }
    } finally {
      details.pinnedPane = previous;
    }
  });

  it("names the section and its sidebar tooltip Cover", async function () {
    const item = await book();
    const attachment = await attach(item);
    await win.ZoteroPane.selectItems([item.id], true);
    await waitFor(() => shows(attachment));
    await waitFor(
      () => section()!.querySelector(".head .title")?.textContent === "Cover",
    );
    const id = section()!.dataset.pane;
    await waitFor(
      () =>
        Array.from(
          win.document.querySelectorAll<HTMLElement>("item-pane-sidenav .btn"),
        )
          .find((button) => button.dataset.pane === id)
          ?.getAttribute("tooltiptext") === "Cover",
    );
  });

  it("keeps an empty section without placeholders and follows provider updates", async function () {
    const item = await book();
    await win.ZoteroPane.selectItems([item.id], true);
    await waitFor(() => !!section() && !section()!.hidden && image()!.hidden);
    const attachment = await attach(item);
    await waitFor(() => shows(attachment));
    await attachment.eraseTx();
    await waitFor(
      () =>
        !section()!.hidden && image()!.hidden && !image()!.hasAttribute("src"),
    );
  });

  it("follows selection, including child and standalone attachments, and hides for groups", async function () {
    const parent = await book();
    const child = await attach(parent);
    const standalone = await attach();
    const placeholder = await book();
    for (const attachment of [child, standalone]) {
      await win.ZoteroPane.selectItems([attachment.id], true);
      await waitFor(() => shows(attachment));
    }
    await win.ZoteroPane.selectItems([placeholder.id], true);
    await waitFor(
      () =>
        !section()!.hidden && image()!.hidden && !image()!.hasAttribute("src"),
    );
    await win.ZoteroPane.selectItems([parent.id], true);
    await waitFor(() => shows(child));
    await win.ZoteroPane.selectItems([parent.id, placeholder.id], true);
    await waitFor(() => win.getComputedStyle(image()!).visibility === "hidden");
    win.ZoteroPane.itemsView.selection.clearSelection();
    await waitFor(() => win.getComputedStyle(image()!).visibility === "hidden");
  });

  for (const stale of [false, true]) {
    it(
      stale
        ? "ignores an earlier selection's delayed online cover"
        : "refreshes an empty section when lookup preferences change",
      async function () {
        const item = await book();
        const isbn = "9780140328721";
        item.setField("ISBN", isbn);
        await item.saveTx();
        const cache = PathUtils.join(
          Zotero.DataDirectory.dir,
          "coverview",
          "covers",
          "open-library",
        );
        const paths = ["jpg", "missing"].map((ext) =>
          PathUtils.join(cache, `${isbn}.${ext}`),
        );
        const backups = await Promise.all(
          paths.map(async (path) =>
            (await IOUtils.exists(path)) ? IOUtils.read(path) : undefined,
          ),
        );
        const request = Zotero.HTTP.request;
        let release: (() => void) | undefined;
        let response: Promise<unknown> | undefined;
        try {
          for (const path of paths)
            await IOUtils.remove(path, { ignoreAbsent: true });
          Zotero.HTTP.request = ((_method: string, url: string) => {
            assert.include(url, `/isbn/${isbn}-L.jpg`);
            response = new Promise<void>((resolve) => {
              release = resolve;
            }).then(() => ({ status: 200, response: jpeg.buffer }));
            return response;
          }) as typeof request;
          await win.ZoteroPane.selectItems([item.id], true);
          await waitFor(
            () => !!section() && !section()!.hidden && image()!.hidden,
          );
          setPref("fetchISBNCover", true);
          await waitFor(() => !!release);
          if (stale) {
            const attachment = await attach();
            await win.ZoteroPane.selectItems([attachment.id], true);
            await waitFor(() => shows(attachment));
            const current = image()!.src;
            release!();
            await response;
            await Zotero.Promise.delay(200);
            assert.equal(image()!.src, current);
            assert.isFalse(section()!.hidden);
          } else {
            release!();
            await waitFor(
              () =>
                !section()!.hidden && !!image()!.src.includes(`${isbn}.jpg`),
            );
            setPref("fetchISBNCover", false);
            await waitFor(
              () =>
                !section()!.hidden &&
                image()!.hidden &&
                !image()!.hasAttribute("src"),
            );
          }
        } finally {
          release?.();
          await response;
          Zotero.HTTP.request = request;
          // Let the controlled response finish its provider cache write.
          await Zotero.Promise.delay(200);
          for (const [index, path] of paths.entries()) {
            if (backups[index]) await IOUtils.write(path, backups[index]!);
            else await IOUtils.remove(path, { ignoreAbsent: true });
          }
        }
      },
    );
  }
});
