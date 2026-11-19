import { assert } from "chai";
import {
  getPref,
  GridFixture,
  Modifiers,
  openGrid,
  openPreferences,
  patch,
  setPref,
  until,
} from "./helpers/gridFixture";

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

/** A grid of fixed size, so that the largest tiles fit its width. */
async function fixedGrid(items = 1): Promise<GridFixture> {
  const grid = await openGrid({ items });
  grid.setStyle({ flex: "none", width: "630px", height: "300px" });
  setPref("tileSize", 180);
  await grid.settled();
  return grid;
}

function tileWidth(grid: GridFixture): number {
  return grid.tile(grid.items[0]).getBoundingClientRect().width;
}

/** Turn the wheel with the primary modifier, `[deltaY, deltaMode]` each. */
function turn(grid: GridFixture, wheels: [number, number?][]): void {
  for (const [deltaY, deltaMode = PIXEL] of wheels) {
    const event = grid.wheel(deltaY, { primary: true, deltaMode });
    assert.isTrue(event.defaultPrevented, "the grid handles the gesture");
  }
}

/** The tile size after turning the wheel, starting from `start`. */
function sizeAfter(
  grid: GridFixture,
  start: number,
  wheels: [number, number?][],
): number {
  setPref("tileSize", start);
  turn(grid, wheels);
  return getPref("tileSize");
}

/** Turn the wheel one notch at a time until the tile size stops changing. */
function turnToLimit(grid: GridFixture, deltaY: number): number {
  for (let notch = 0; notch < 100; notch++) {
    const size = getPref("tileSize");
    turn(grid, [[deltaY]]);
    if (getPref("tileSize") === size) return size;
  }
  throw new Error("The tile size kept changing");
}

describe("wheel resizing", function () {
  describe("tile size", function () {
    it("grows tiles on a notch up and shrinks them on a notch down", async function () {
      const grid = await fixedGrid();
      const size = getPref("tileSize");
      const width = tileWidth(grid);
      turn(grid, [[-100]]);
      assert.isAbove(getPref("tileSize"), size);
      assert.isAbove(tileWidth(grid), width);
      turn(grid, [[100]]);
      assert.equal(getPref("tileSize"), size);
      turn(grid, [[100]]);
      assert.isBelow(getPref("tileSize"), size);
      assert.isBelow(tileWidth(grid), width);
    });

    for (const [mode, wheels, notch] of [
      ["pixel", [[-40], [-60]], [-100, PIXEL]],
      [
        "line",
        [
          [-1, LINE],
          [-2, LINE],
        ],
        [-3, LINE],
      ],
    ] as [string, [number, number?][], [number, number]][]) {
      it(`accumulates partial ${mode} deltas into whole notches`, async function () {
        const grid = await fixedGrid();
        const start = getPref("tileSize");
        const oneNotch = sizeAfter(grid, start, [notch]);
        assert.isAbove(oneNotch, start);
        assert.equal(
          sizeAfter(grid, start, wheels.slice(0, 1)),
          start,
          "a partial notch does not resize yet",
        );
        turn(grid, wheels.slice(1));
        assert.equal(getPref("tileSize"), oneNotch, "the notch completes");
      });
    }

    it("resizes by one notch per page", async function () {
      const grid = await fixedGrid();
      const start = getPref("tileSize");
      assert.equal(
        sizeAfter(grid, start, [[-1, PAGE]]),
        sizeAfter(grid, start, [[-100]]),
      );
    });

    it("resizes by several notches for a large delta", async function () {
      const grid = await fixedGrid();
      const start = getPref("tileSize");
      const twoNotches = sizeAfter(grid, start, [[100], [100]]);
      assert.isBelow(twoNotches, sizeAfter(grid, start, [[100]]));
      assert.equal(sizeAfter(grid, start, [[200]]), twoNotches);
    });

    for (const [limit, deltaY] of [
      ["largest", -100],
      ["smallest", 100],
    ] as const) {
      it(`stops at the ${limit} tile size and turns back on the next notch`, async function () {
        const grid = await fixedGrid();
        const size = turnToLimit(grid, deltaY);
        const width = tileWidth(grid);
        turn(grid, [[deltaY]]);
        assert.equal(getPref("tileSize"), size, "the size stays at its limit");
        assert.equal(tileWidth(grid), width);

        // Partial notches past the limit are discarded.
        const turnedBack = (when: string) =>
          deltaY < 0
            ? assert.isBelow(getPref("tileSize"), size, when)
            : assert.isAbove(getPref("tileSize"), size, when);
        turn(grid, [[-deltaY], [deltaY * 1.5]]);
        assert.equal(getPref("tileSize"), size, "back at the limit");
        turn(grid, [[-deltaY]]);
        turnedBack("after overshooting the limit");
        turn(grid, [[deltaY], [deltaY * 0.4], [-deltaY]]);
        turnedBack("after turning on at the limit");
      });
    }
  });

  describe("ignored gestures", function () {
    const ignored: [string, (mac: boolean) => Modifiers][] = [
      ["without a modifier", () => ({})],
      [
        "with the other platform's modifier",
        (mac) => (mac ? { ctrl: true } : { meta: true }),
      ],
      ["with both Command and Control", () => ({ ctrl: true, meta: true })],
      ["with Alt", () => ({ primary: true, alt: true })],
      ["with Shift", () => ({ primary: true, shift: true })],
    ];
    for (const [name, modifiers] of ignored) {
      it(`ignores the wheel ${name}`, async function () {
        const grid = await fixedGrid();
        const mac = grid.win.navigator.platform.startsWith("Mac");
        const size = getPref("tileSize");
        const event = grid.wheel(-100, modifiers(mac));
        await grid.settled();
        assert.isFalse(event.defaultPrevented);
        assert.equal(getPref("tileSize"), size);
      });
    }

    it("ignores the wheel outside the grid view", async function () {
      const grid = await fixedGrid();
      const size = getPref("tileSize");
      const mac = grid.win.navigator.platform.startsWith("Mac");
      const event = new grid.win.WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
        ctrlKey: !mac,
        metaKey: mac,
      });
      grid.toggleButton.dispatchEvent(event);
      await grid.settled();
      assert.isFalse(event.defaultPrevented);
      assert.equal(getPref("tileSize"), size);
    });

    it("ignores the wheel while the native item tree is shown", async function () {
      const grid = await fixedGrid();
      await grid.showList();
      const size = getPref("tileSize");
      const event = grid.wheel(-100, { primary: true });
      await grid.settled();
      assert.isFalse(event.defaultPrevented);
      assert.equal(getPref("tileSize"), size);
    });

    for (const [platform, primary, other] of [
      ["MacIntel", { meta: true }, { ctrl: true }],
      ["Win32", { ctrl: true }, { meta: true }],
      ["Linux x86_64", { ctrl: true }, { meta: true }],
    ] as const) {
      it(`resizes only with ${"meta" in primary ? "Command" : "Control"} on ${platform}`, async function () {
        const grid = await fixedGrid();
        patch(grid.win.navigator, "platform", platform);
        const size = getPref("tileSize");
        assert.isFalse(grid.wheel(-100, other).defaultPrevented);
        assert.equal(getPref("tileSize"), size);
        assert.isTrue(grid.wheel(-100, primary).defaultPrevented);
        assert.isAbove(getPref("tileSize"), size);
      });
    }
  });

  it("keeps the first visible item, selection and focus across wheel and width changes", async function () {
    const grid = await fixedGrid(40);
    const [, selected, next] = grid.displayedItems();
    grid.click(selected);
    await grid.settled();
    const start = grid.displayedItems()[2 * grid.columns()];
    grid.scrollToTile(start, 37);
    await until(
      () => grid.currentCover(start),
      `the cover of item ${start} to be shown`,
    );
    const active = grid.win.document.activeElement;
    const steps: [string, () => void][] = [
      ["a notch up", () => turn(grid, [[-100]])],
      ...[900, 700, 450, 630].map(
        (width) =>
          [
            `width ${width}px`,
            () => grid.setStyle({ width: `${width}px` }),
          ] as [string, () => void],
      ),
    ];
    for (const [step, apply] of steps) {
      // Pick the anchor afresh, whether or not the gesture pause elapsed.
      grid.endResizeGesture();
      const anchor = grid.topRow()[0];
      const clipped = grid.isClippedAtTop(anchor);
      const tile = grid.tile(anchor);
      const cover = grid.currentCover(anchor);
      const size = getPref("tileSize");
      apply();
      await grid.settled();
      assert.include(grid.topRow(), anchor, `after ${step}`);
      assert.equal(grid.isClippedAtTop(anchor), clipped, `after ${step}`);
      assert.strictEqual(grid.tile(anchor), tile, `tile kept after ${step}`);
      if (cover)
        assert.deepEqual(grid.currentCover(anchor), cover, `after ${step}`);
      if (step.startsWith("width"))
        assert.equal(getPref("tileSize"), size, "width keeps the tile size");
      grid.assertMountsNearViewport();
      assert.deepEqual(grid.selectedItems(), [selected]);
      assert.equal(grid.focusedItem(), selected);
      assert.strictEqual(grid.win.document.activeElement, active);
    }

    grid.press("ArrowRight", { shift: true });
    await grid.settled();
    assert.sameMembers(grid.selectedItems(), [selected, next]);
  });

  it("moves the settings slider along with a wheel change", async function () {
    const grid = await fixedGrid();
    const prefs = await openPreferences();
    const slider = prefs.document.getElementById(
      "zotero-prefpane-coverview-tile-size",
    ) as HTMLInputElement;
    const size = getPref("tileSize");
    await until(
      () => slider.value === String(size),
      "the slider to show the tile size",
      { observe: () => slider.value },
    );
    turn(grid, [[-100]]);
    assert.isAbove(getPref("tileSize"), size);
    await until(
      () => slider.value === String(getPref("tileSize")),
      "the slider to follow the wheel",
      { observe: () => [slider.value, getPref("tileSize")] },
    );
  });
});
