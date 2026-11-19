import { assert } from "chai";
import {
  createRenderer,
  displayItems,
  RendererFixture,
  RendererOptions,
  setAppPref,
  until,
} from "./helpers/gridFixture";

/** The first item of the top visible row, and whether it is cut off. */
function firstVisible(view: RendererFixture) {
  const item = view.topRow()[0];
  return { item, clipped: view.isClippedAtTop(item) };
}

function assertKeeps(
  view: RendererFixture,
  anchor: { item: number; clipped: boolean },
  when: string,
): void {
  assert.include(
    view.topRow(),
    anchor.item,
    `item ${anchor.item} stays in the top visible row ${when}`,
  );
  assert.equal(
    view.isClippedAtTop(anchor.item),
    anchor.clipped,
    `item ${anchor.item} stays ${anchor.clipped ? "" : "un"}clipped ${when}`,
  );
  view.assertMountsNearViewport();
}

interface Scenario {
  name: string;
  options: RendererOptions;
  /** Prepare the renderer before scrolling. */
  setup?: (view: RendererFixture) => Promise<void>;
  /** Scroll to this position before picking the first visible item. */
  scrollTop?: number;
  /** How far the viewport starts below the top of the first visible item. */
  offset?: number;
  changes: [string, (view: RendererFixture) => void | Promise<void>][];
  /** Check that the changes exercise what the scenario is about. */
  check?: (columns: number[]) => void;
}

const padded = { padding: "19px 23px", gap: "31px 17px" };

const scenarios: Scenario[] = [
  {
    name: "tile size and column count changes",
    options: { items: 301, ...padded },
    changes: [
      ["larger tiles", (view) => view.resize({ columns: 2, tileSize: 240 })],
      ["smaller tiles", (view) => view.resize({ columns: 4, tileSize: 90 })],
      [
        "the original size",
        (view) => view.resize({ columns: 3, tileSize: 180 }),
      ],
    ],
  },
  {
    name: "width changes with automatic columns",
    options: { items: 301, columns: "auto-fill", width: 650, ...padded },
    changes: [460, 850, 650, 460, 650].map((width) => [
      `width ${width}px`,
      (view) => view.restyle({ width }),
    ]),
    check: (columns) => assert.isAbove(new Set(columns).size, 2),
  },
  {
    name: "a scrollbar appearing and disappearing",
    options: {
      items: 301,
      columns: "auto-fill",
      width: 619,
      padding: "19px",
      gap: "20px",
    },
    setup: async (view) => {
      // Overlay scrollbars take no width; use classic ones on every system.
      setAppPref("ui.useOverlayScrollbars", 0);
      const { grid } = view;
      await until(
        () => grid.offsetWidth > grid.clientWidth,
        "the scrollbar to take up width",
        { observe: () => [grid.offsetWidth, grid.clientWidth] },
      );
      await view.setHostStyle({ "overflow-y": "hidden" });
    },
    changes: ["auto", "hidden", "auto"].map((overflow) => [
      `overflow ${overflow}`,
      (view) => view.setHostStyle({ "overflow-y": overflow }),
    ]),
    check: (columns) => assert.notEqual(columns[0], columns[1]),
  },
  {
    name: "automatic column changes near the largest tile size",
    options: {
      items: 3001,
      columns: "auto-fill",
      tileSize: 351,
      width: 1520,
      padding: "19px",
      gap: "20px",
    },
    scrollTop: 4000,
    changes: [360, 351, 360, 351].map((tileSize) => [
      `tile size ${tileSize}px`,
      (view) => view.resize({ tileSize }),
    ]),
    check: (columns) => assert.isAbove(new Set(columns).size, 1),
  },
  {
    name: "explicit column changes with the viewport starting in a row gap",
    options: { items: 301, padding: "19px 23px", gap: "80px 17px" },
    offset: -40,
    changes: [
      ["two columns", (view) => view.resize({ columns: 2, tileSize: 240 })],
      ["three columns", (view) => view.resize({ columns: 3, tileSize: 180 })],
    ],
  },
  {
    name: "automatic column changes with the viewport starting in a row gap",
    options: { items: 301, padding: "19px 23px", gap: "80px 17px" },
    offset: -40,
    changes: [2, 4, 3].map((columns) => [
      `${columns} columns`,
      (view) => view.restyle({ columns }),
    ]),
  },
  {
    name: "column style changes that leave the host size unchanged",
    options: { items: 301 },
    changes: [2, 3].map((columns) => [
      `${columns} columns`,
      (view) => view.restyle({ columns }),
    ]),
    check: (columns) => assert.deepEqual(columns, [2, 3]),
  },
];

/** Several changes in one resize gesture, without a pause in between. */
const gestures: (Pick<Scenario, "options" | "changes"> & { kind: string })[] = [
  {
    kind: "explicit tile size",
    options: { items: 301, ...padded },
    changes: [
      { columns: 2, tileSize: 240 },
      { columns: 4, tileSize: 150 },
      { columns: 3, tileSize: 180 },
    ].map((layout) => [
      `at ${layout.columns} columns`,
      (view) => view.resize(layout),
    ]),
  },
  {
    kind: "automatic width",
    options: { items: 301, columns: "auto-fill", width: 650, ...padded },
    changes: [460, 850, 650, 460, 650].map((width) => [
      `at width ${width}px`,
      (view) => view.restyle({ width }),
    ]),
  },
];

describe("viewport anchor", function () {
  for (const { name, ...scenario } of scenarios) {
    it(`keeps the first visible item in the top row across ${name}`, async function () {
      const view = createRenderer(scenario.options);
      await scenario.setup?.(view);
      // Start a few rows down, so that changes can move the anchor either way.
      view.scroll(scenario.scrollTop ?? 0);
      const items = view.displayedItems();
      const start = items[items.indexOf(view.topRow()[0]) + 2 * view.columns()];
      view.scrollToTile(start, scenario.offset ?? 37);
      const columns: number[] = [];
      for (const [change, apply] of scenario.changes) {
        // Pick the anchor afresh, whether or not the gesture pause elapsed.
        view.endResizeGesture();
        const anchor = firstVisible(view);
        await apply(view);
        assertKeeps(view, anchor, `after ${change}`);
        columns.push(view.columns());
      }
      scenario.check?.(columns);
    });
  }

  for (const { kind, options, changes } of gestures) {
    it(`keeps the same item anchored through several ${kind} changes in one gesture`, async function () {
      const view = createRenderer(options);
      const anchor = view.displayedItems()[2 * view.columns()];
      view.scrollToTile(anchor, 37);
      const clipped = view.isClippedAtTop(anchor);
      const columns = new Set<number>();
      for (const [when, apply] of changes) {
        await apply(view);
        assertKeeps(view, { item: anchor, clipped }, when);
        columns.add(view.columns());
      }
      assert.isAbove(columns.size, 1, "the changes reflow the columns");
    });
  }

  it("keeps a deeply clipped item partly visible when its row shrinks", function () {
    const view = createRenderer({ items: 301 });
    const anchor = view.displayedItems()[6];
    const height = view.tile(anchor).getBoundingClientRect().height;
    view.scrollToTile(anchor, height - 2);
    assert.isTrue(view.isClippedAtTop(anchor));
    view.resize({ columns: 4, tileSize: 90 });
    assertKeeps(view, { item: anchor, clipped: true }, "after shrinking");
    view.resize({ columns: 3, tileSize: 180 });
    assertKeeps(view, { item: anchor, clipped: true }, "after growing");
  });

  for (const [restart, act] of [
    [
      "after the user scrolls, even back to the same position",
      (view: RendererFixture) => {
        const top = view.grid.scrollTop;
        view.scroll(top + 600);
        view.scroll(top);
      },
    ],
    [
      "after the resize gesture ends",
      (view: RendererFixture) => view.endResizeGesture(),
    ],
  ] as const) {
    it(`anchors the first item of the top row ${restart}`, function () {
      const view = createRenderer({ items: 301 });
      const original = view.displayedItems()[6];
      view.scrollToTile(original, 20);
      view.resize({ columns: 4, tileSize: 150 });
      act(view);
      const anchor = firstVisible(view);
      assert.notEqual(anchor.item, original, "the top row starts elsewhere");
      view.resize({ columns: 3, tileSize: 180 });
      assertKeeps(view, anchor, "after the next change");
    });
  }

  for (const mode of ["explicit", "automatic"] as const) {
    const change = (
      view: RendererFixture,
      columns: number,
      tileSize: number,
    ) =>
      mode === "explicit"
        ? view.resize({ columns, tileSize })
        : view.restyle({ columns, tileSize });

    it(`stops at the start when an ${mode} change moves the anchor into the first row`, async function () {
      const view = createRenderer({
        items: 301,
        padding: "19px 23px",
        gap: "80px 17px",
      });
      const [first] = view.displayedItems();
      const height = view.tile(first).getBoundingClientRect().height;
      view.scrollToTile(first, height + 1);
      const anchor = view.topRow()[0];
      await change(view, 4, 120);
      assert.isTrue(view.atStart);
      assert.include(view.visibleItems(), anchor);
      view.assertMountsNearViewport();
    });

    it(`stays at the end when an ${mode} change shortens the grid`, async function () {
      const view = createRenderer({
        items: 301,
        padding: "19px 23px",
        gap: "80px 17px",
      });
      view.scroll(view.grid.scrollHeight);
      await change(view, 5, 90);
      assert.isTrue(view.atEnd);
      view.assertMountsNearViewport();
    });
  }

  it("keeps empty and short grids at the start", function () {
    const view = createRenderer({ padding: "24px" });
    for (const count of [0, 1, 3]) {
      view.setItems(displayItems(count), { showCreators: false });
      for (const tileSize of [90, 240, 180]) {
        view.resize({ tileSize });
        assert.isTrue(view.atStart, `${count} items at ${tileSize}px`);
        assert.lengthOf(view.mountedItems(), count);
      }
    }
  });
});
