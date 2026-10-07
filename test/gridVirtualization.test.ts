import { assert } from "chai";
import { GridRenderer } from "../src/modules/gridRenderer";
import { createRendererHost } from "./helpers/rendererHost";

describe("grid on-demand tiles", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  const items = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: index % 2 ? "A creator" : "",
          getDisplayTitle: () => `Virtual item ${index}`,
          getField: () => (index % 2 ? "2026" : ""),
        }) as Zotero.Item,
    );

  // IntersectionObserver also clips against the browser viewport, not only its
  // root. Native integration tests may leave the document scrolled elsewhere.
  function showCoverHost(host: HTMLElement): HTMLElement {
    const wrapper = host.ownerDocument.createElement("div");
    wrapper.style.cssText = "position:fixed;top:0;left:0";
    host.before(wrapper);
    wrapper.append(host);
    return wrapper;
  }

  it("keeps mounted tiles bounded across repeated traversal and distant jumps, even with all items selected", function () {
    const host = createRendererHost();
    host.style.padding = "24px";
    const renderer = new GridRenderer(host, () => {});
    try {
      const collection = items(60001);
      renderer.setItems(collection, { showCreators: true });
      renderer.setSelection(collection.map((item) => item.id));
      const height = host.scrollHeight;
      for (const fraction of [0.1, 0.2, 0.3, 0.8, 0.5, 1, 0, 1]) {
        host.scrollTop = height * fraction;
        host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
        assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
        assert.equal(host.scrollHeight, height);
      }
      assert.notExists(host.querySelector('[data-item-id="-1"]'));
      const last = host.querySelector<HTMLElement>('[data-item-id="-60001"]')!;
      assert.equal(last.getAttribute("aria-posinset"), "60001");
      assert.equal(last.getAttribute("aria-selected"), "true");
      assert.isAtMost(
        last.getBoundingClientRect().bottom,
        host.getBoundingClientRect().bottom + 1,
      );
    } finally {
      renderer.destroy();
    }
  });

  it("preserves a partially visible item across tile and column changes in both directions", function () {
    const host = createRendererHost();
    host.style.padding = "19px 23px";
    host.style.gap = "31px 17px";
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop = tile.offsetTop + 37;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const offset =
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(2,240px)";
        host.style.setProperty("--cover-view-tile-size", "240px");
      });
      assert.equal(renderer.getVerticalDestination(-7, 1), -9);
      assert.closeTo(
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
      );
      assert.strictEqual(host.querySelector('[data-item-id="-7"]'), tile);
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(3,180px)";
        host.style.setProperty("--cover-view-tile-size", "180px");
      });
      assert.closeTo(
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
      );
      assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
    } finally {
      renderer.destroy();
    }
  });

  it("keeps a deeply clipped first visible item visible when shrinking its row", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      const tile = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop = tile.offsetTop + tile.getBoundingClientRect().height - 2;
      assert.closeTo(
        tile.getBoundingClientRect().bottom - host.getBoundingClientRect().top,
        2,
        1,
      );
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(4,90px)";
        host.style.setProperty("--cover-view-tile-size", "90px");
      });
      assert.isAbove(
        tile.getBoundingClientRect().bottom,
        host.getBoundingClientRect().top,
        "The original anchor must retain some visible pixels",
      );
      assert.isBelow(
        tile.getBoundingClientRect().top,
        host.getBoundingClientRect().top,
      );
      const offset =
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(3,180px)";
        host.style.setProperty("--cover-view-tile-size", "180px");
      });
      assert.closeTo(
        tile.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
        "The next resize still anchors the same visible item",
      );
      const next = host.querySelector<HTMLElement>('[data-item-id="-13"]')!;
      host.scrollTop = next.offsetTop + 20;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const nextOffset =
        next.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(4,90px)";
        host.style.setProperty("--cover-view-tile-size", "90px");
      });
      assert.closeTo(
        next.getBoundingClientRect().top - host.getBoundingClientRect().top,
        nextOffset,
        1,
        "Scrolling establishes a new item anchor",
      );
    } finally {
      renderer.destroy();
    }
  });

  it("establishes a new anchor after scrolling away and back to the restored position", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const scroll = (top: number) => {
      host.scrollTop = top;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
    };
    try {
      renderer.setItems(items(301), { showCreators: true });
      const original = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      scroll(original.offsetTop + 20);
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(4,150px)";
        host.style.setProperty("--cover-view-tile-size", "150px");
      });
      const restoredTop = host.scrollTop;
      scroll(restoredTop + 600);
      scroll(restoredTop);
      const first = host.querySelector<HTMLElement>('[data-item-id="-5"]')!;
      const offset =
        first.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(3,180px)";
        host.style.setProperty("--cover-view-tile-size", "180px");
      });
      assert.closeTo(
        first.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
        "User scrolling replaces the retained resize anchor even at the same final position",
      );
    } finally {
      renderer.destroy();
    }
  });

  it("starts a fresh anchor at the current row after pausing between resize gestures", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      const original = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop = original.offsetTop + 20;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(4,150px)";
        host.style.setProperty("--cover-view-tile-size", "150px");
      });
      await Zotero.Promise.delay(400);
      const first = host.querySelector<HTMLElement>('[data-item-id="-5"]')!;
      const offset =
        first.getBoundingClientRect().top - host.getBoundingClientRect().top;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(3,180px)";
        host.style.setProperty("--cover-view-tile-size", "180px");
      });
      assert.closeTo(
        first.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
        "A new gesture anchors the leading item of the current visible row",
      );
    } finally {
      renderer.destroy();
    }
  });

  it("preserves the item offset near maximum tile size when auto-fill changes from four columns to three", function () {
    const host = createRendererHost();
    host.style.cssText +=
      ";box-sizing:border-box;width:1520px;height:600px;padding:19px;gap:20px;grid-template-columns:repeat(auto-fill,minmax(var(--cover-view-tile-size),1fr));--cover-view-tile-size:351px";
    const renderer = new GridRenderer(host, () => {});
    const columns = () =>
      host.ownerDocument
        .defaultView!.getComputedStyle(host)!
        .gridTemplateColumns.split(/\s+/).length;
    try {
      renderer.setItems(items(3001), { showCreators: true });
      assert.equal(columns(), 4);
      const first = host.querySelector<HTMLElement>('[data-item-id="-1"]')!;
      const secondRow = host.querySelector<HTMLElement>('[data-item-id="-5"]')!;
      host.scrollTop =
        first.offsetTop + (secondRow.offsetTop - first.offsetTop) * 10 + 37;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const anchor = host.querySelector<HTMLElement>('[data-item-id="-41"]')!;
      const offset =
        anchor.getBoundingClientRect().top - host.getBoundingClientRect().top;
      for (const [size, expectedColumns] of [
        [360, 3],
        [351, 4],
        [360, 3],
        [351, 4],
      ]) {
        renderer.refreshLayout(() =>
          host.style.setProperty("--cover-view-tile-size", `${size}px`),
        );
        assert.equal(columns(), expectedColumns);
        assert.closeTo(
          anchor.getBoundingClientRect().top - host.getBoundingClientRect().top,
          offset,
          1,
          `Offset at ${size}px`,
        );
      }
    } finally {
      renderer.destroy();
    }
  });

  it("anchors the next visible row across gaps and clamps at the beginning and end", function () {
    const host = createRendererHost();
    host.style.padding = "19px 23px";
    host.style.gap = "80px 17px";
    const renderer = new GridRenderer(host, () => {});
    const resize = (columns: number, size: number) =>
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = `repeat(${columns},${size}px)`;
        host.style.setProperty("--cover-view-tile-size", `${size}px`);
      });
    try {
      renderer.setItems(items(301), { showCreators: true });
      const preceding = host.querySelector<HTMLElement>('[data-item-id="-4"]')!;
      const anchor = host.querySelector<HTMLElement>('[data-item-id="-7"]')!;
      host.scrollTop =
        preceding.offsetTop + preceding.getBoundingClientRect().height + 10;
      const offset =
        anchor.getBoundingClientRect().top - host.getBoundingClientRect().top;
      assert.isAbove(offset, 0, "Viewport starts in the gap before the anchor");
      resize(2, 240);
      assert.closeTo(
        anchor.getBoundingClientRect().top - host.getBoundingClientRect().top,
        offset,
        1,
      );

      host.scrollTop = 0;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      const first = host.querySelector<HTMLElement>('[data-item-id="-1"]')!;
      host.scrollTop =
        first.offsetTop + first.getBoundingClientRect().height + 1;
      resize(4, 120);
      assert.equal(
        host.scrollTop,
        0,
        "Anchor moves into the first row and clamps at the beginning",
      );

      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new host.ownerDocument.defaultView!.Event("scroll"));
      resize(5, 90);
      assert.equal(
        host.scrollTop,
        host.scrollHeight - host.clientHeight,
        "Shrinking near the end clamps to the new scroll boundary",
      );
      assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 40);
    } finally {
      renderer.destroy();
    }
  });

  it("keeps empty and short grids stable when resizing with padding", function () {
    const host = createRendererHost();
    host.style.padding = "24px";
    const renderer = new GridRenderer(host, () => {});
    try {
      for (const count of [0, 1, 3]) {
        renderer.setItems(items(count), { showCreators: false });
        for (const size of [90, 240, 180]) {
          renderer.refreshLayout(() => {
            host.style.gridTemplateColumns = `repeat(3,${size}px)`;
            host.style.setProperty("--cover-view-tile-size", `${size}px`);
          });
          assert.equal(host.scrollTop, 0);
          assert.equal(host.querySelectorAll(".grid-view-item").length, count);
        }
      }
    } finally {
      renderer.destroy();
    }
  });

  it("updates mounted row positions when column styles change without resizing the host", async function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      await Zotero.Promise.delay(50);
      const first = host.querySelector<HTMLElement>('[data-item-id="-1"]')!;
      const third = host.querySelector<HTMLElement>('[data-item-id="-3"]')!;
      assert.equal(first.offsetTop, third.offsetTop);
      host.style.gridTemplateColumns = "repeat(2,150px)";
      await Zotero.Promise.delay(50);
      assert.isAbove(third.offsetTop, first.offsetTop);
    } finally {
      renderer.destroy();
    }
  });

  it("retains only the active drag source until dragend, including across item updates", async function () {
    const host = createRendererHost();
    const win = host.ownerDocument.defaultView!;
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
    );
    try {
      const collection = items(3001);
      renderer.setItems(collection, { showCreators: true });
      const source = host.querySelector<HTMLElement>('[data-item-id="-1"]')!;
      const event = new win.Event("dragstart", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "dataTransfer", { value: {} });
      source.dispatchEvent(event);
      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new win.Event("scroll"));
      assert.isTrue(host.contains(source));
      assert.notExists(host.querySelector('[data-item-id="-2"]'));
      assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 25);
      renderer.setItems(collection.slice().reverse(), { showCreators: true });
      assert.isTrue(
        host.contains(source),
        "A native drag source must stay connected until dragend",
      );
      let connectedDuringDragend = false;
      source.addEventListener(
        "dragend",
        () => {
          connectedDuringDragend = host.contains(source);
        },
        { once: true },
      );
      source.dispatchEvent(new win.Event("dragend", { bubbles: true }));
      assert.isTrue(
        connectedDuringDragend,
        "Dispatch finishes before deferred updates detach the source",
      );
      await Zotero.Promise.delay(0);
      assert.isFalse(host.contains(source));
      assert.equal(
        host
          .querySelector('[data-item-id="-1"]')
          ?.getAttribute("aria-posinset"),
        "3001",
      );
      assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
    } finally {
      renderer.destroy();
    }
  });

  it("ignores late covers on retired tiles and reuses the cached result on remount", async function () {
    const host = createRendererHost();
    const wrapper = showCoverHost(host);
    const win = host.ownerDocument.defaultView!;
    const renderer = new GridRenderer(host, () => {});
    const directory = PathUtils.join(
      PathUtils.tempDir,
      "opencode",
      `retirement-${Zotero.Utilities.randomString()}`,
    );
    const path = PathUtils.join(directory, "cover.png");
    let item: Zotero.Item | undefined;
    let release!: (path: string) => void;
    let pathReads = 0;
    try {
      await IOUtils.makeDirectory(directory, { createAncestors: true });
      const canvas = host.ownerDocument.createElement("canvas");
      canvas.width = canvas.height = 2;
      await IOUtils.write(
        path,
        Uint8Array.from(
          win.atob(canvas.toDataURL().split(",")[1]),
          (character) => character.charCodeAt(0),
        ),
      );
      const pendingPath = new Promise<string>((resolve) => {
        release = resolve;
      });
      // A standalone attachment at the Zotero/file-system boundary, invisible
      // to native indexing and the separately bundled installed add-on cache.
      item = {
        id: -80000,
        itemType: "attachment",
        attachmentContentType: "image/png",
        getDisplayTitle: () => "Delayed image",
        getField: () => "",
        isFileAttachment: () => true,
        isRegularItem: () => false,
        getFilePathAsync: async () => {
          pathReads++;
          return pendingPath;
        },
      } as unknown as Zotero.Item;
      const collection = [item, ...items(3000)];
      renderer.setItems(collection, { showCreators: false });
      const oldTile = host.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      const deadline = Date.now() + 4000;
      while (!pathReads && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.equal(
        pathReads,
        1,
        "Cover resolution started at the file-system seam",
      );
      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new win.Event("scroll"));
      assert.isFalse(host.contains(oldTile));
      renderer.setSelection([item.id]);
      renderer.setFocusedItem(item.id, true);
      const tile = host.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      assert.notStrictEqual(tile, oldTile);
      release(path);
      const completionDeadline = Date.now() + 4000;
      while (
        tile.querySelector("img")!.hidden &&
        Date.now() < completionDeadline
      )
        await Zotero.Promise.delay(20);
      assert.isFalse(oldTile.querySelector("img")!.hasAttribute("src"));
      assert.isTrue(oldTile.querySelector("img")!.hidden);
      assert.equal(
        tile.querySelector("img")!.dataset.coverSource,
        "attachment",
      );
      assert.isFalse(tile.querySelector("img")!.hidden);
      assert.equal(tile.getAttribute("aria-selected"), "true");
      assert.isTrue(tile.classList.contains("focused"));
      assert.isFalse(
        host.classList.contains("owns-focus"),
        "Remounted selection is inactive outside grid focus",
      );
      const uri = tile.querySelector("img")!.src;
      renderer.refreshLayout(() => {
        host.style.gridTemplateColumns = "repeat(2,240px)";
        host.style.setProperty("--cover-view-tile-size", "240px");
      });
      assert.strictEqual(
        host.querySelector(`[data-item-id="${item.id}"]`),
        tile,
      );
      assert.equal(tile.querySelector("img")!.src, uri);
      assert.isFalse(tile.querySelector("img")!.hidden);
      assert.equal(pathReads, 1, "Resizing retains the loaded cover");
      renderer.setFocusedItem(undefined);
      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new win.Event("scroll"));
      renderer.setFocusedItem(item.id, true);
      await Zotero.Promise.delay(100);
      assert.equal(
        host
          .querySelector(`[data-item-id="${item.id}"] img`)!
          .getAttribute("src"),
        uri,
      );
      assert.equal(pathReads, 1, "Unchanged cover is not regenerated");
    } finally {
      release?.(path);
      renderer.destroy();
      await IOUtils.remove(path, { ignoreAbsent: true });
      await IOUtils.remove(directory, { ignoreAbsent: true });
      wrapper.remove();
    }
  });

  it("matches a fully populated native CSS grid for every caption configuration, padding, gaps and incomplete rows", function () {
    const host = createRendererHost();
    host.style.cssText +=
      ";grid-template-columns:repeat(3,150px);height:200px;padding:19px 23px;gap:31px 17px;justify-content:center;--cover-view-tile-size:150px";
    const renderer = new GridRenderer(host, () => {});
    const collection = items(13);
    const reference = createRendererHost();
    try {
      for (const showTitles of [false, true]) {
        for (const showCreators of [false, true]) {
          for (const showYears of [false, true]) {
            renderer.setItems(collection, {
              showTitles,
              showCreators,
              showYears,
            });
            const tiles = collection.map((item) => {
              renderer.setFocusedItem(item.id);
              return host
                .querySelector(`[data-item-id="${item.id}"]`)!
                .cloneNode(true) as HTMLElement;
            });
            reference.style.cssText = host.style.cssText;
            reference.style.gridTemplateRows = "none";
            reference.replaceChildren(
              ...Array.from(tiles, (child) => {
                const tile = child.cloneNode(true) as HTMLElement;
                tile.style.cssText = "";
                tile.removeAttribute("id");
                return tile;
              }),
            );
            assert.equal(
              host.scrollHeight,
              reference.scrollHeight,
              `titles ${showTitles}, creators ${showCreators}, years ${showYears}`,
            );
            const actual = host.querySelector<HTMLElement>(
              '[data-item-id="-13"]',
            )!;
            const expected = reference.querySelector<HTMLElement>(
              '[data-item-id="-13"]',
            )!;
            assert.closeTo(
              actual.getBoundingClientRect().top -
                host.getBoundingClientRect().top,
              expected.getBoundingClientRect().top -
                reference.getBoundingClientRect().top,
              0.02,
            );
            assert.closeTo(
              actual.getBoundingClientRect().left -
                host.getBoundingClientRect().left,
              expected.getBoundingClientRect().left -
                reference.getBoundingClientRect().left,
              0.02,
            );
          }
        }
      }
    } finally {
      renderer.destroy();
    }
  });

  it("remounts current captions and tags, preserving offscreen selection and bounded independent focus without scrolling", function () {
    const host = createRendererHost();
    const win = host.ownerDocument.defaultView!;
    const renderer = new GridRenderer(host, () => {});
    const collection = items(3001);
    let tags = [{ tag: "⭐ Original", color: null }];
    Object.assign(collection[1], { getItemsListTags: () => tags });
    try {
      renderer.setItems(collection, { showCreators: true });
      renderer.setSelection([-2, -1500]);
      renderer.setFocusedItem(-3);
      const old = host.querySelector('[data-item-id="-2"]')!;
      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new win.Event("scroll"));
      assert.isFalse(host.contains(old));
      assert.exists(
        host.querySelector('[data-item-id="-3"]'),
        "Only the independent focus exception stays mounted",
      );
      const scrollTop = host.scrollTop;
      for (const id of [-1000, -2000, -2500]) {
        renderer.setFocusedItem(id);
        assert.equal(
          host.scrollTop,
          scrollTop,
          "Focus-only updates never scroll",
        );
        assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 25);
        const active = host.getAttribute("aria-activedescendant")!;
        assert.exists(host.querySelector(`[id="${active}"]`));
      }
      assert.notExists(host.querySelector('[data-item-id="-3"]'));
      collection[1].firstCreator = "Updated creator";
      tags = [{ tag: "📚 Current", color: null }];
      renderer.setItems(collection, { showCreators: true });
      renderer.setFocusedItem(-2, true);
      const remounted = host.querySelector('[data-item-id="-2"]')!;
      assert.notStrictEqual(remounted, old);
      assert.equal(
        remounted.querySelector(".grid-view-creators")!.textContent,
        "Updated creator",
      );
      assert.equal(
        remounted.querySelector(".grid-view-tag")!.getAttribute("title"),
        "📚 Current",
      );
      assert.equal(
        remounted.querySelector(".grid-view-year")!.textContent,
        "2026",
      );
      assert.equal(remounted.getAttribute("aria-selected"), "true");
      assert.isTrue(remounted.classList.contains("focused"));
      assert.notExists(host.querySelector('[data-item-id="-1500"]'));
      renderer.destroy();
      renderer.refreshLayout();
      host.dispatchEvent(new win.Event("scroll"));
      assert.notExists(host.querySelector(".grid-view-item"));
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
    } finally {
      renderer.destroy();
    }
  });

  it("releases destroyed grids and ignores pending cover completion and queued layout callbacks", async function () {
    const host = createRendererHost();
    const wrapper = showCoverHost(host);
    const win = host.ownerDocument.defaultView!;
    const renderer = new GridRenderer(host, () => {});
    let release!: (path: string) => void;
    let started = false;
    const pendingPath = new Promise<string>((resolve) => {
      release = resolve;
    });
    const item = {
      ...items(1)[0],
      id: -80001,
      attachmentContentType: "image/png",
      isFileAttachment: () => true,
      getFilePathAsync: () => {
        started = true;
        return pendingPath;
      },
    } as unknown as Zotero.Item;
    try {
      renderer.setItems([item, ...items(3000)], { showCreators: false });
      renderer.setFocusedItem(item.id);
      const tile = host.querySelector<HTMLElement>(
        `[data-item-id="${item.id}"]`,
      )!;
      const deadline = Date.now() + 4000;
      while (!started && Date.now() < deadline) await Zotero.Promise.delay(20);
      assert.isTrue(started);
      host.style.gridTemplateColumns = "repeat(2,180px)";
      renderer.destroy();
      release("/tmp/opencode/destroyed-cover.png");
      await Zotero.Promise.delay(50);
      host.dispatchEvent(new win.Event("scroll"));
      renderer.refreshLayout();
      assert.isEmpty(host.children);
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
      assert.isFalse(tile.querySelector("img")!.hasAttribute("src"));
      const replacement = new GridRenderer(host, () => {});
      try {
        replacement.setItems(items(301), { showCreators: false });
        assert.isAtMost(host.querySelectorAll(".grid-view-item").length, 24);
        assert.notExists(host.querySelector('[data-item-id="-80001"]'));
      } finally {
        replacement.destroy();
      }
    } finally {
      release?.("/tmp/opencode/destroyed-cover.png");
      renderer.destroy();
      wrapper.remove();
    }
  });

  it("reveals offscreen focus and menu anchors without changing independent selection or mounting preceding rows", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(3001), { showCreators: true });
      renderer.setSelection([-2, -1500]);
      renderer.setFocusedItem(-3001, true);
      const focused = host.querySelector<HTMLElement>(
        '[data-item-id="-3001"]',
      )!;
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.equal(focused.getAttribute("aria-selected"), "false");
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 40);
      assert.notExists(host.querySelector('[data-item-id="-1000"]'));
      const anchor = renderer.ensureVisibleMenuAnchor([-1500]);
      assert.equal(anchor?.dataset.itemId, "-1500");
      assert.equal(anchor?.getAttribute("aria-selected"), "true");
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.notExists(host.querySelector('[data-item-id="-1000"]'));
      renderer.setFocusedItem(undefined);
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
    } finally {
      renderer.destroy();
    }
  });

  it("recomputes geometry and clamps scroll after resizing, caption changes, sorting and filtering", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    const collection = items(301);
    try {
      host.style.gridTemplateColumns = "repeat(3,150px)";
      renderer.setItems(collection, { showCreators: true });
      renderer.setFocusedItem(-301, true);
      const height = host.scrollHeight;
      host.style.gridTemplateColumns = "repeat(2,150px)";
      renderer.refreshLayout();
      assert.isAbove(host.scrollHeight, height);
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      const captionHeight = host.scrollHeight;
      renderer.setItems(collection, {
        showCreators: false,
        showTitles: false,
        showYears: false,
      });
      assert.isBelow(host.scrollHeight, captionHeight);
      host.style.setProperty("--cover-view-tile-size", "100px");
      renderer.refreshLayout();
      assert.isBelow(host.scrollHeight, captionHeight);
      renderer.setItems(collection.slice(0, 3).reverse(), {
        showCreators: false,
      });
      assert.equal(host.scrollTop, 0);
      assert.deepEqual(
        Array.from(
          host.querySelectorAll<HTMLElement>(".grid-view-item"),
          (entry) => entry.dataset.itemId,
        ),
        ["-3", "-2", "-1"],
      );
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
      renderer.setItems([], { showCreators: false });
      assert.notExists(host.querySelector(".grid-view-item"));
      assert.equal(host.scrollHeight, host.clientHeight);
    } finally {
      renderer.destroy();
    }
  });

  it("defers hidden layouts and restores the required window on becoming visible", function () {
    const host = createRendererHost();
    const renderer = new GridRenderer(host, () => {});
    try {
      renderer.setItems(items(301), { showCreators: true });
      renderer.setFocusedItem(-301, true);
      const height =
        host.querySelector<HTMLElement>(".grid-view-spacer")!.style.height;
      host.style.display = "none";
      host.style.gridTemplateColumns = "repeat(2,150px)";
      renderer.refreshLayout();
      assert.equal(
        host.querySelector<HTMLElement>(".grid-view-spacer")!.style.height,
        height,
      );
      renderer.setItems(items(133), { showCreators: false });
      renderer.setFocusedItem(-133);
      assert.isFalse(host.hasAttribute("aria-activedescendant"));
      host.style.display = "grid";
      renderer.refreshLayout();
      renderer.setFocusedItem(-133, true);
      assert.equal(renderer.getVerticalDestination(-2, 1), -4);
      const focused = host.querySelector<HTMLElement>('[data-item-id="-133"]')!;
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.isAbove(host.scrollHeight, host.clientHeight);
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 30);
    } finally {
      renderer.destroy();
    }
  });

  it("represents the full collection immediately and jumps to the end without intervening tiles", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    host.style.cssText =
      "display:grid;grid-template-columns:repeat(3,150px);gap:24px 20px;padding:19px 23px;width:500px;height:200px;overflow:auto;align-content:start;--cover-view-tile-size:150px";
    win.document.documentElement.append(host);
    const renderer = new GridRenderer(host, () => {});
    const items = Array.from(
      { length: 60001 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Virtual item ${index}`,
        }) as Zotero.Item,
    );
    try {
      renderer.setItems(items, { showCreators: false, showYears: false });
      assert.isAbove(
        host.scrollHeight,
        4000000,
        "All 20001 rows contribute height",
      );
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 20);
      const height = host.scrollHeight;
      host.scrollTop = height;
      host.dispatchEvent(new win.Event("scroll"));
      await Zotero.Promise.delay(50);
      const last = host.querySelector<HTMLElement>('[data-item-id="-60001"]');
      assert.exists(last);
      assert.isBelow(host.querySelectorAll(".grid-view-item").length, 40);
      assert.notExists(host.querySelector('[data-item-id="-1500"]'));
      assert.equal(host.scrollHeight, height);
      assert.equal(last!.getAttribute("aria-posinset"), "60001");
      assert.equal(last!.getAttribute("aria-setsize"), "60001");
    } finally {
      renderer.destroy();
      host.remove();
    }
  });
});
