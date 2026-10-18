import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import {
  registerCoverColumn,
  unregisterCoverColumn,
} from "../src/modules/coverColumn";
import { CoverProvider } from "../src/modules/coverProvider";
import { getPref, setPref } from "../src/utils/prefs";
import { coverImageFixture } from "./helpers/coverFixture";

type Column = _ZoteroTypes.ItemTreeManager.ItemTreeCustomColumnOptions;

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(condition(), "cover column did not update");
}

describe("cover column refresh", function () {
  this.timeout(20000);
  const keys = [
    "enableGridView",
    "fetchISBNCover",
    "fetchMetadataCover",
  ] as const;
  let saved: boolean[];
  let originalRegister: typeof Zotero.ItemTreeManager.registerColumn;
  let originalTrigger: typeof Zotero.Notifier.trigger;
  let column: Column;
  let host: HTMLElement;
  let item: Zotero.Item;
  let directory: string;
  let file: string;
  let cachedData: string | undefined;

  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: (Zotero as typeof Zotero & { CoverView: typeof addon }).CoverView,
      configurable: true,
    });
    Object.defineProperty(globalThis, "ztoolkit", {
      value: new BasicTool(),
      configurable: true,
    });
  });

  after(function () {
    CoverProvider.unregisterNotifier();
    Reflect.deleteProperty(globalThis, "addon");
    Reflect.deleteProperty(globalThis, "ztoolkit");
  });

  function render(): void {
    // Native row data may remain cached when only cells are re-rendered.
    const data = (cachedData ??= column.dataProvider!(item, "cover"));
    host.replaceChildren(
      column.renderCell!(
        0,
        data,
        { className: "cover", dataKey: "cover", label: "Cover" },
        false,
        host.ownerDocument!,
      ),
    );
  }

  beforeEach(async function () {
    saved = keys.map(getPref);
    keys.forEach((key) => setPref(key, false));
    originalRegister = Zotero.ItemTreeManager.registerColumn;
    originalTrigger = Zotero.Notifier.trigger;
    Zotero.ItemTreeManager.registerColumn = ((options: Column) => {
      column = options;
      return "test-cover";
    }) as typeof originalRegister;
    Zotero.Notifier.trigger = ((event, type, ids, ...args) => {
      if (event === "redraw" && type === "item") render();
      return originalTrigger.call(Zotero.Notifier, event, type, ids, ...args);
    }) as typeof originalTrigger;
    host = Zotero.getMainWindow()!.document.createElement("div");
    Zotero.getMainWindow()!.document.documentElement!.append(host);
    directory = `/tmp/opencode/column-${Zotero.Utilities.randomString()}`;
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    file = PathUtils.join(directory, "cover.png");
    await IOUtils.write(file, coverImageFixture(40, 60));
    item = new Zotero.Item("book");
    item.setField("title", "Cover column refresh test");
    await item.saveTx();
    cachedData = undefined;
    CoverProvider.registerNotifier();
    await registerCoverColumn();
  });

  afterEach(async function () {
    unregisterCoverColumn();
    Zotero.ItemTreeManager.registerColumn = originalRegister;
    Zotero.Notifier.trigger = originalTrigger;
    host.remove();
    await item.eraseTx();
    keys.forEach((key, index) => setPref(key, saved[index]));
    CoverProvider.clearCache();
    await IOUtils.remove(directory, { recursive: true });
  });

  it("refreshes an existing displayed cover on provider notifications without grid view", async function () {
    render();
    const image = () => host.querySelector("img");
    await waitFor(() => !!image());
    const placeholder = image()!.src;
    const selection = Zotero.getMainWindow()!.ZoteroPane.getSelectedItems(true);
    const attachment = await Zotero.Attachments.importFromFile({
      file,
      parentItemID: item.id,
    });
    await waitFor(() => !!image()?.src.includes(attachment.key));
    await attachment.eraseTx();
    await waitFor(() => image()?.src === placeholder);
    assert.deepEqual(
      Zotero.getMainWindow()!.ZoteroPane.getSelectedItems(true),
      selection,
    );
  });

  for (const scenario of ["refresh", "recycle", "teardown"] as const) {
    it(`ignores a delayed cover after ${scenario}`, async function () {
      await Zotero.Attachments.importFromFile({ file, parentItemID: item.id });
      const read = IOUtils.read;
      let release: (() => void) | undefined;
      let pending: Promise<Uint8Array> | undefined;
      let oldCell: HTMLElement | undefined;
      let replacement: Zotero.Item | undefined;
      const originalItem = item;
      IOUtils.read = ((path, options) => {
        const result = read(path, options);
        if (options?.maxBytes !== 1 || pending) return result;
        pending = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => result);
        return pending;
      }) as typeof read;
      try {
        // Start a fresh lookup whose filesystem probe is held at the boundary.
        CoverProvider.invalidate(item.id);
        render();
        const oldLookup = CoverProvider.getCover(item.id);
        await waitFor(() => !!release);
        oldCell = host.firstElementChild as HTMLElement;
        if (scenario === "refresh") {
          setPref("fetchISBNCover", true);
          await waitFor(() => host.firstElementChild !== oldCell);
        } else if (scenario === "recycle") {
          replacement = new Zotero.Item("book");
          replacement.setField("title", "Recycled row");
          await replacement.saveTx();
          item = replacement;
          cachedData = undefined;
          render();
          await waitFor(() => !!host.querySelector("img"));
        } else {
          unregisterCoverColumn();
        }
        release!();
        await pending;
        await oldLookup;
        await Zotero.Promise.delay(100);
        assert.isNull(
          oldCell.querySelector("img"),
          "obsolete cell stays empty",
        );
        if (scenario !== "teardown") {
          await waitFor(() => !!host.querySelector("img"));
          assert.lengthOf(host.querySelectorAll("img"), 1);
        }
      } finally {
        release?.();
        await pending;
        IOUtils.read = read;
        if (replacement) {
          await replacement.eraseTx();
          item = originalItem;
        }
      }
    });
  }

  it("re-resolves cached covers when lookup preferences change", async function () {
    const isbn = "9780140328721";
    item.setField("ISBN", isbn);
    await item.saveTx();
    const cache = PathUtils.join(
      Zotero.DataDirectory.dir,
      "coverview",
      "covers",
      "open-library",
    );
    const path = PathUtils.join(cache, `${isbn}.jpg`);
    const backup = (await IOUtils.exists(path))
      ? await IOUtils.read(path)
      : undefined;
    try {
      await IOUtils.makeDirectory(cache, { createAncestors: true });
      await IOUtils.write(path, coverImageFixture(40, 60, "image/jpeg"));
      render();
      const image = () => host.querySelector("img");
      await waitFor(() => !!image());
      const placeholder = image()!.src;
      setPref("fetchISBNCover", true);
      await waitFor(() => !!image()?.src.includes(`${isbn}.jpg`));
      setPref("fetchISBNCover", false);
      await waitFor(() => image()?.src === placeholder);
    } finally {
      if (backup) await IOUtils.write(path, backup);
      else await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("refreshes across registration cycles and stops updating after teardown", async function () {
    render();
    await waitFor(() => !!host.querySelector("img"));
    await registerCoverColumn();
    const image = () => host.querySelector("img")!;
    let previous = image().src;
    // Changing metadata through the public provider emits a cover change
    // without involving the separately bundled running add-on's notifier.
    item.setField("title", "New placeholder title");
    await item.saveTx({ skipNotifier: true });
    CoverProvider.cacheCover(item);
    await waitFor(() => !!image() && image().src !== previous);
    unregisterCoverColumn();
    previous = image().src;
    item.setField("title", "Title changed after teardown");
    await item.saveTx({ skipNotifier: true });
    CoverProvider.cacheCover(item);
    await CoverProvider.getCover(item.id);
    assert.equal(image().src, previous);
    await registerCoverColumn();
    item.setField("title", "Title changed after re-registration");
    await item.saveTx({ skipNotifier: true });
    CoverProvider.cacheCover(item);
    await waitFor(() => !!image() && image().src !== previous);
  });
});
