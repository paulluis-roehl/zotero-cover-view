/**
 * Test fixtures for the grid view.
 *
 * `openGrid` shows the live grid view of the Zotero main window for a fresh
 * collection, and offers user-like actions and observations addressed by item.
 * `createRenderer` builds a standalone grid renderer for geometry and
 * virtualization tests that are hard to reach through the live grid view.
 *
 * Everything a fixture touches (items, collections, prefs, patched globals,
 * view mode, the selected collection and its selection, extra windows and
 * renderers) is restored by a root hook after every test, even when it fails.
 * Fixtures can therefore only be used from tests and `beforeEach` hooks.
 *
 * Every test file is bundled separately, so run-wide state lives on a shared
 * global and the hooks are registered once for the whole run.
 */

import { config } from "../../package.json";
import {
  GridItemCommand,
  GridItemCommandOptions,
  GridNavigationCommand,
  GridRenderer,
  GridRenderOptions,
  GridSelectionModifiers,
} from "../../src/modules/gridRenderer";
import { inventBook } from "./testEnvironment";

type Plugin = import("../../src/addon").default;
type PluginPrefs = _ZoteroTypes.Prefs["PluginPrefsMap"];
type Cleanup = () => void | Promise<void>;

/** An item, or the ID of an item. */
export type ItemRef = Zotero.Item | number;

/** Where dragged data is moved: an item's tile, grid whitespace, or an element. */
export type DragTarget = ItemRef | "whitespace" | Element;

export interface Modifiers {
  /** The platform's primary modifier: Command on macOS, Control elsewhere. */
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Raw Control, regardless of platform. */
  ctrl?: boolean;
  /** Raw Meta (Command), regardless of platform. */
  meta?: boolean;
}

interface Scope {
  cleanups: Cleanup[];
  items: Zotero.Item[];
  collections: Zotero.Collection[];
  prefs: Set<string>;
}

interface SharedState {
  scopes: Scope[];
  /** The collection tree row of the empty collection shown between tests. */
  emptyRow?: string;
}

const STATE_KEY = Symbol.for("zotero-cover-view.gridFixture");
const DEFAULT_TIMEOUT = 5000;

const state: SharedState = ((globalThis as Record<symbol, unknown>)[
  STATE_KEY
] ??= createState()) as SharedState;

function createState(): SharedState {
  const created: SharedState = { scopes: [] };
  // Root hooks wrap every test of the run, including failing ones.
  const run = prepareRun(created);
  before(run.start);
  after(run.end);
  beforeEach(beginFixtureScope);
  afterEach(endFixtureScope);
  return created;
}

/**
 * Prepare Zotero for the whole run, and undo it afterwards:
 *
 * - Show an empty collection in the main window. Tests start from, and
 *   fixtures restore, this empty view, which is cheap to show and unaffected
 *   by items elsewhere.
 * - Let the database skip syncing to disk on every commit. Each test creates
 *   and erases its items, and syncing dominates that on some file systems.
 *   This risks the test data directory only on an OS crash or power loss.
 */
function prepareRun(shared: SharedState) {
  let home: string | undefined;
  let emptyCollection: Zotero.Collection | undefined;
  let synchronous: unknown;
  return {
    async start() {
      synchronous = await Zotero.DB.valueQueryAsync("PRAGMA synchronous");
      await Zotero.DB.queryAsync("PRAGMA synchronous = OFF");
      const pane = mainWindow().ZoteroPane;
      home = selectedRow(pane);
      emptyCollection = new Zotero.Collection();
      emptyCollection.name = `Cover View test run ${inventBook().title}`;
      emptyCollection.libraryID = Zotero.Libraries.userLibraryID;
      await emptyCollection.saveTx({ skipSelect: true });
      shared.emptyRow = `C${emptyCollection.id}`;
      await collectionsView(pane).selectByID(shared.emptyRow);
      await settled();
    },
    async end() {
      shared.emptyRow = undefined;
      if (home) await collectionsView(mainWindow().ZoteroPane).selectByID(home);
      if (emptyCollection?.id) await emptyCollection.eraseTx();
      if (typeof synchronous === "number")
        await Zotero.DB.queryAsync(`PRAGMA synchronous = ${synchronous}`);
    },
  };
}

/** Start collecting cleanups for a test. Registered as a root hook. */
export function beginFixtureScope(): void {
  state.scopes.push({
    cleanups: [],
    items: [],
    collections: [],
    prefs: new Set(),
  });
}

/**
 * Restore everything touched since the matching `beginFixtureScope`: run
 * cleanups in reverse order, then erase created items and collections in one
 * transaction. All cleanups run even if some fail; failures are reported
 * together afterwards.
 */
export async function endFixtureScope(): Promise<void> {
  const scope = state.scopes.pop();
  if (!scope) return;
  const errors: unknown[] = [];
  const attempt = async (cleanup: Cleanup) => {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  };
  for (const cleanup of scope.cleanups.reverse()) await attempt(cleanup);
  await attempt(async () => {
    // Erasing a parent also erases its children, so look each one up again.
    const lookups = [
      ...scope.items.map(
        ({ id }) =>
          () =>
            Zotero.Items.get(id),
      ),
      ...scope.collections.map(
        ({ id }) =>
          () =>
            Zotero.Collections.get(id),
      ),
    ];
    if (!lookups.some((lookup) => lookup())) return;
    await Zotero.DB.executeTransaction(async () => {
      for (const lookup of lookups) {
        const object = lookup();
        if (object) await object.erase();
      }
    });
  });
  await attempt(() => settled());
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new Error(
      `Fixture teardown failed:\n${errors.map(String).join("\n")}`,
    );
}

function currentScope(): Scope {
  const scope = state.scopes.at(-1);
  if (!scope)
    throw new Error(
      "Grid fixtures can only be used inside a test or beforeEach hook",
    );
  return scope;
}

/** Run `cleanup` when the current test ends, after later-registered ones. */
export function onTeardown(cleanup: Cleanup): void {
  currentScope().cleanups.push(cleanup);
}

/** Erase these items or collections when the current test ends. */
export function track<T extends Zotero.Item | Zotero.Collection>(
  ...objects: T[]
): T[] {
  const scope = currentScope();
  for (const object of objects) {
    if (object instanceof Zotero.Collection) scope.collections.push(object);
    else scope.items.push(object as Zotero.Item);
  }
  return objects;
}

// Waiting ---------------------------------------------------------------------

function plugin(): Plugin {
  return (Zotero as unknown as Record<string, Plugin>)[config.addonInstance];
}

function mainWindow(): _ZoteroTypes.MainWindow {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("The Zotero main window is not open");
  return win;
}

function itemsView(pane: _ZoteroTypes.ZoteroPane): _ZoteroTypes.ItemTree {
  if (!pane.itemsView) throw new Error("The native item tree is not loaded");
  return pane.itemsView;
}

function collectionsView(
  pane: _ZoteroTypes.ZoteroPane,
): _ZoteroTypes.CollectionTree {
  if (!pane.collectionsView)
    throw new Error("The native collection tree is not loaded");
  return pane.collectionsView;
}

/**
 * The ID of the first selected collection tree row, such as `C12`. Zotero 10
 * removed the single-row getter in favour of `getCollectionTreeRows()`.
 */
export function selectedRow(pane: _ZoteroTypes.ZoteroPane): string | undefined {
  const rows = (
    pane as unknown as { getCollectionTreeRows(): { id: string }[] }
  ).getCollectionTreeRows();
  return rows[0]?.id;
}

/** Resolves once the window's grid view reflects the native item tree. */
export function settled(win: Window = mainWindow()): Promise<void> {
  return plugin().testing.settled(win);
}

/**
 * Resolves once `win` has painted a frame, such as after a native view
 * `settled` does not cover. Frames need an active window (`focusWindow`).
 */
export function painted(win: Window): Promise<void> {
  return new Promise<void>((resolve) =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())),
  );
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Wait until `condition` returns a truthy value and return it. Use this only
 * for conditions that `settled` does not cover. On timeout, the failure names
 * `description` and the last observed state: `observe()` if given, otherwise
 * the condition's last value.
 */
export async function until<T>(
  condition: () => T,
  description: string,
  {
    timeout = DEFAULT_TIMEOUT,
    observe,
  }: { timeout?: number; observe?: () => unknown } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let value = condition();
  while (!value) {
    if (Date.now() >= deadline) {
      let observed: unknown = value;
      if (observe) {
        try {
          observed = observe();
        } catch (error) {
          observed = `observation failed: ${error}`;
        }
      }
      throw new Error(
        `Timed out after ${timeout}ms waiting for ${description}. Last observed: ${describeValue(observed)}`,
      );
    }
    await Zotero.Promise.delay(20);
    value = condition();
  }
  return value as NonNullable<T>;
}

// Prefs and globals -----------------------------------------------------------

function prefName(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

/** Set a plugin pref until the end of the current test. */
export function setPref<K extends keyof PluginPrefs>(
  key: K,
  value: PluginPrefs[K],
): void {
  restorePref(key);
  Zotero.Prefs.set(prefName(key), value, true);
}

/**
 * Set an application pref, such as `ui.useOverlayScrollbars`, until the end
 * of the current test.
 */
export function setAppPref(
  name: string,
  value: string | number | boolean,
): void {
  restorePrefNamed(name);
  Zotero.Prefs.set(name, value, true);
}

/** Restore a plugin pref that the UI may change when the current test ends. */
function restorePref(key: keyof PluginPrefs): void {
  restorePrefNamed(prefName(key));
}

function restorePrefNamed(name: string): void {
  const scope = currentScope();
  if (scope.prefs.has(name)) return;
  scope.prefs.add(name);
  const hadValue = Services.prefs.prefHasUserValue(name);
  const original = Zotero.Prefs.get(name, true);
  scope.cleanups.push(() => {
    if (hadValue) Zotero.Prefs.set(name, original!, true);
    else Zotero.Prefs.clear(name, true);
  });
}

/** Reset a plugin pref to its default until the end of the current test. */
export function clearPref(key: keyof PluginPrefs): void {
  restorePref(key);
  Zotero.Prefs.clear(prefName(key), true);
}

/** Read a plugin pref. */
export function getPref<K extends keyof PluginPrefs>(key: K): PluginPrefs[K] {
  return Zotero.Prefs.get(prefName(key), true) as PluginPrefs[K];
}

/**
 * Show the application in a light or dark theme until the end of the current
 * test.
 */
export async function useTheme(theme: "light" | "dark"): Promise<void> {
  setAppPref("browser.theme.toolbar-theme", theme === "dark" ? 0 : 1);
  await until(
    () =>
      Zotero.getMainWindows().every(
        (win) =>
          win.matchMedia("(prefers-color-scheme: dark)").matches ===
          (theme === "dark"),
      ),
    `the ${theme} theme to apply`,
  );
}

/**
 * Assign `colour` to the tag `name` in a library until the end of the current
 * test. `position` is the tag's number-key position, starting at 0.
 */
export async function setTagColour(
  name: string,
  colour: string,
  position = 0,
  libraryID = Zotero.Libraries.userLibraryID,
): Promise<void> {
  const previous = Zotero.Tags.getColor(libraryID, name) as
    { color: string; position: number } | false;
  onTeardown(async () => {
    if (!Zotero.Libraries.exists(libraryID)) return;
    if (previous)
      await Zotero.Tags.setColor(
        libraryID,
        name,
        previous.color,
        previous.position,
      );
    else if (Zotero.Tags.getColor(libraryID, name))
      await Zotero.Tags.setColor(libraryID, name, "", 0);
  });
  await Zotero.Tags.setColor(libraryID, name, colour, position);
}

/** Set a library's synced setting until the end of the current test. */
export async function setSyncedSetting(
  libraryID: number,
  setting: string,
  value: unknown,
): Promise<void> {
  const settings = (
    Zotero as unknown as {
      SyncedSettings: {
        get(libraryID: number, setting: string): unknown;
        set(libraryID: number, setting: string, value: unknown): Promise<void>;
        clear(libraryID: number, setting: string): Promise<void>;
      };
    }
  ).SyncedSettings;
  const previous = settings.get(libraryID, setting);
  onTeardown(async () => {
    if (!Zotero.Libraries.exists(libraryID)) return;
    if (previous === null || previous === undefined)
      await settings.clear(libraryID, setting);
    else await settings.set(libraryID, setting, previous);
  });
  await settings.set(libraryID, setting, value);
}

/**
 * Replace `target[key]` until the end of the current test and return the
 * original value. Inherited getter-only properties, such as
 * `navigator.platform`, are shadowed by an own property. Patch only what the
 * test itself needs; patching a module's statics does not reach the live
 * plugin's own copy of that module.
 */
export function patch<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): T[K] {
  const original = target[key];
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const inherited = descriptor ? undefined : findInherited(target, key);
  onTeardown(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else if (inherited?.set) target[key] = original;
    else delete target[key];
  });
  if (descriptor && !descriptor.writable && !descriptor.set)
    Object.defineProperty(target, key, { ...descriptor, value });
  else if (inherited?.get && !inherited.set)
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
    });
  else target[key] = value;
  return original;
}

function findInherited(
  target: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  for (
    let proto = Object.getPrototypeOf(target);
    proto;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

// Focus -----------------------------------------------------------------------

/*
 * The test runner's own window keeps the system focus, so Gecko moves the
 * active element of the Zotero window without dispatching focus events. These
 * helpers dispatch the events a focused window would receive.
 */

/** Move keyboard focus to `element`, as clicking or tabbing to it would. */
export function focus(element: Element): void {
  const doc = element.ownerDocument!;
  const win = doc.defaultView!;
  const previous = doc.activeElement;
  (element as HTMLElement).focus();
  if (doc.activeElement !== element)
    throw new Error(`Element ${describeElement(element)} cannot take focus`);
  if (previous === element || doc.hasFocus()) return;
  if (previous) {
    previous.dispatchEvent(
      new win.FocusEvent("blur", { relatedTarget: element }),
    );
    previous.dispatchEvent(
      new win.FocusEvent("focusout", { bubbles: true, relatedTarget: element }),
    );
  }
  element.dispatchEvent(
    new win.FocusEvent("focus", { relatedTarget: previous }),
  );
  element.dispatchEvent(
    new win.FocusEvent("focusin", { bubbles: true, relatedTarget: previous }),
  );
}

/** Activate `win`, as switching to it from another application would. */
export function focusWindow(win: Window): void {
  win.focus();
  // Also undoes a synthetic `blurWindow` of a window that kept system focus.
  win.dispatchEvent(new win.Event("focus"));
}

/**
 * Deactivate `win`, as switching to another application would. It is
 * activated again when the current test ends.
 */
export function blurWindow(win: Window): void {
  onTeardown(() => {
    if (!win.closed) win.dispatchEvent(new win.Event("focus"));
  });
  win.dispatchEvent(new win.Event("blur"));
}

function describeElement(element: Element): string {
  return `<${element.localName}${element.id ? ` id="${element.id}"` : ""}>`;
}

// Items -----------------------------------------------------------------------

export interface ItemSpec {
  itemType?: _ZoteroTypes.Item.ItemTypeMapping[keyof _ZoteroTypes.Item.ItemTypeMapping];
  /** Defaults to an invented title. */
  title?: string;
  /** Further changes to the item before it is saved. */
  setup?: (item: Zotero.Item) => void;
}

/** A note that is not the child of another item. */
export const standaloneNote: ItemSpec = {
  itemType: "note",
  setup: (note) => note.setNote("Standalone note"),
};

function itemID(item: ItemRef): number {
  return typeof item === "number" ? item : item.id;
}

function describeItem(item: ItemRef): string {
  const id = itemID(item);
  const found = Zotero.Items.get(id);
  const title = found ? found.getDisplayTitle() : "";
  return title ? `item ${id} ("${title}")` : `item ${id}`;
}

/** Create a collection that is erased when the current test ends. */
export async function createCollection(
  name = `Grid fixture ${inventBook().title}`,
  libraryID = Zotero.Libraries.userLibraryID,
): Promise<Zotero.Collection> {
  const collection = new Zotero.Collection();
  collection.name = name;
  collection.libraryID = libraryID;
  track(collection);
  // The collection tree would otherwise select a new collection.
  await collection.saveTx({ skipSelect: true });
  return collection;
}

/**
 * Create an editable group library. It is erased when the current test ends,
 * after the views showing it have been restored.
 */
export async function createGroup(): Promise<Zotero.Group> {
  const group = new Zotero.Group({
    groupID: 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000),
    name: `Grid fixture group ${inventBook().title}`,
    description: "",
    version: 0,
  });
  group.editable = true;
  group.filesEditable = true;
  onTeardown(async () => {
    if (Zotero.Libraries.exists(group.libraryID)) await group.eraseTx();
  });
  await group.saveTx();
  await Zotero.SyncedSettings.loadAll(group.libraryID);
  return group;
}

/**
 * Create a saved search for the items of `collection`. It is erased when the
 * current test ends.
 */
export async function createSavedSearch(
  collection: Zotero.Collection,
): Promise<Zotero.Search> {
  const search = new Zotero.Search({
    name: `Grid fixture search ${inventBook().title}`,
    libraryID: collection.libraryID,
  });
  search.addCondition("collection", "is", collection.key);
  onTeardown(async () => {
    if (search.id && Zotero.Searches.get(search.id)) await search.eraseTx();
  });
  await search.saveTx();
  return search;
}

/**
 * Create items in one transaction, optionally in `collection`. They are erased
 * when the current test ends.
 */
export async function createItems(
  specs: number | ItemSpec[],
  collection?: Zotero.Collection,
): Promise<Zotero.Item[]> {
  const list = typeof specs === "number" ? Array(specs).fill({}) : specs;
  const created: Zotero.Item[] = [];
  await Zotero.DB.executeTransaction(async () => {
    for (const spec of list as ItemSpec[]) {
      const item = new Zotero.Item(spec.itemType ?? "book");
      item.libraryID = collection?.libraryID ?? Zotero.Libraries.userLibraryID;
      if (spec.itemType !== "note" && spec.itemType !== "attachment")
        item.setField("title", spec.title ?? inventBook().title);
      spec.setup?.(item);
      if (collection) item.addToCollection(collection.id);
      track(item);
      await item.save();
      created.push(item);
    }
  });
  return created;
}

// Shared observations ---------------------------------------------------------

export type CoverKind = "attachment" | "online" | "placeholder";

/** An average painted colour, as `[red, green, blue]`. */
export type Colour = [number, number, number];

export interface CaptionLine {
  text: string;
  tooltip: string;
}

export interface TagIndicator {
  /** The tag name, as named to assistive technology and in the tooltip. */
  name: string;
  /** The emoji shown for an emoji tag. */
  emoji?: string;
  /** The painted colour of a coloured tag's swatch. */
  colour?: string;
}

export interface TagIndicators {
  /** Indicators shown before the title, in order. */
  shown: TagIndicator[];
  /** The indicator summarising tags that do not fit, such as `+2`. */
  overflow?: { text: string; names: string[] };
}

export interface ItemTypeBadge {
  /** The localized item type shown as the badge's tooltip. */
  label: string;
  /** The painted icon image. */
  icon: string;
  visible: boolean;
  /** Whether the badge lies entirely within the tile's cover. */
  onCover: boolean;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Observations of a grid's tiles and scrolled viewport, shared by the live
 * grid view and standalone renderers.
 */
export abstract class GridViewport {
  /** The scrolling element holding the tiles. */
  abstract get grid(): HTMLElement;

  /** IDs of the items the grid displays, in display order. */
  abstract displayedItems(): number[];

  /** The tile for `item`, or `null` if it is not mounted. */
  findTile(item: ItemRef): HTMLElement | null {
    return this.grid.querySelector<HTMLElement>(
      `.grid-view-item[data-item-id="${itemID(item)}"]`,
    );
  }

  /** The mounted tile for `item`. */
  tile(item: ItemRef): HTMLElement {
    const tile = this.findTile(item);
    if (!tile)
      throw new Error(
        `No tile is mounted for ${describeItem(item)}. Mounted: ${describeValue(this.mountedItems())}`,
      );
    return tile;
  }

  /** IDs of items with a mounted tile, in tile order. */
  mountedItems(): number[] {
    return this.tiles().map((tile) => Number(tile.dataset.itemId));
  }

  /** IDs of items whose tile is at least partly inside the grid viewport. */
  visibleItems(): number[] {
    return this.visibleTiles().map(({ id }) => id);
  }

  /** Whether the tile for `item` is at least partly inside the grid viewport. */
  isVisible(item: ItemRef): boolean {
    return this.visibleItems().includes(itemID(item));
  }

  /** The share of the height of the tile for `item` inside the grid viewport. */
  visibleShare(item: ItemRef): number {
    const rect = this.tile(item).getBoundingClientRect();
    const viewport = this.viewport();
    const visible =
      Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top);
    return Math.max(0, visible) / rect.height;
  }

  /** IDs of the visible items in the topmost visible row, in tile order. */
  topRow(): number[] {
    const visible = this.visibleTiles();
    const top = Math.min(...visible.map(({ rect }) => rect.top));
    return visible
      .filter(({ rect }) => Math.abs(rect.top - top) < 1)
      .map(({ id }) => id);
  }

  /** The number of tiles in the widest row of mounted tiles. */
  columns(): number {
    const rows = new Map<number, number>();
    for (const tile of this.tiles()) {
      const top = Math.round(tile.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    return Math.max(0, ...rows.values());
  }

  /** Whether the top edge of the viewport cuts through the tile for `item`. */
  isClippedAtTop(item: ItemRef): boolean {
    const rect = this.tile(item).getBoundingClientRect();
    const { top } = this.viewport();
    return rect.top < top && rect.bottom > top;
  }

  /** Whether the grid is scrolled to its start. */
  get atStart(): boolean {
    return this.grid.scrollTop <= 0;
  }

  /** Whether the grid is scrolled to its end. */
  get atEnd(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.grid;
    return scrollTop >= scrollHeight - clientHeight - 1;
  }

  /** IDs of mounted tiles the grid presents as selected. */
  presentedSelection(): number[] {
    return Array.from(
      this.grid.querySelectorAll<HTMLElement>(
        '.grid-view-item[aria-selected="true"]',
      ),
      (tile: HTMLElement) => Number(tile.dataset.itemId),
    );
  }

  /** ID of the item of the focused tile. */
  focusedItem(): number | undefined {
    const id = this.grid.getAttribute("aria-activedescendant");
    const tile = id ? this.grid.ownerDocument.getElementById(id) : null;
    return tile ? Number((tile as HTMLElement).dataset.itemId) : undefined;
  }

  /** The cover shown on the tile for `item`, if any. */
  currentCover(item: ItemRef): { kind: CoverKind; uri: string } | undefined {
    const image = this.tile(item).querySelector("img");
    const uri = image?.getAttribute("src");
    if (!image || image.hidden || !uri) return undefined;
    return { kind: image.dataset.coverSource as CoverKind, uri };
  }

  /** The cover image element of the tile for `item`. */
  coverImage(item: ItemRef): HTMLImageElement {
    return this.tile(item).querySelector("img")!;
  }

  /**
   * The average colour of the cover area of the tile for `item`, as painted
   * on screen, as `[red, green, blue]`.
   */
  paintedCover(item: ItemRef): Colour {
    const frame = this.coverImage(item).parentElement!;
    const rect = frame.getBoundingClientRect();
    const win = this.grid.ownerDocument.defaultView!;
    const canvas = win.document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    const context = canvas.getContext("2d") as CanvasRenderingContext2D & {
      drawWindow(
        win: Window,
        x: number,
        y: number,
        width: number,
        height: number,
        background: string,
      ): void;
    };
    context.drawWindow(
      win,
      rect.left + win.scrollX,
      rect.top + win.scrollY,
      canvas.width,
      canvas.height,
      "white",
    );
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const sum = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4)
      for (let channel = 0; channel < 3; channel++)
        sum[channel] += data[index + channel];
    const pixels = data.length / 4;
    return sum.map((value) => value / pixels) as Colour;
  }

  /** The accessible name of the tile for `item`. */
  accessibleName(item: ItemRef): string {
    return this.tile(item).getAttribute("aria-label") ?? "";
  }

  /** The accessible description of the tile for `item`. */
  accessibleDescription(item: ItemRef): string {
    return this.tile(item).getAttribute("aria-description") ?? "";
  }

  /** The tile caption of `item`: each line's visible text and tooltip. */
  captionLines(item: ItemRef): CaptionLine[] {
    const caption = this.tile(item).querySelector("figcaption");
    if (!caption) return [];
    return Array.from(caption.children, (line) => {
      // The title line also holds tag indicators, observed separately.
      const text = line.querySelector<HTMLElement>(".grid-view-title") ?? line;
      return {
        text: text.textContent ?? "",
        tooltip: (text as HTMLElement).title,
      };
    });
  }

  /** The innermost caption element of the tile for `item` showing `text`. */
  captionText(item: ItemRef, text: string): HTMLElement {
    const caption = this.tile(item).querySelector("figcaption");
    const matches = Array.from(
      caption?.querySelectorAll<HTMLElement>("*") ?? [],
    ).filter((element) => element.textContent === text);
    const innermost = matches.find(
      (element) =>
        !matches.some((other) => element.contains(other) && other !== element),
    );
    if (!innermost)
      throw new Error(
        `The caption of ${describeItem(item)} does not show "${text}". Caption: ${describeValue(this.captionLines(item))}`,
      );
    return innermost;
  }

  /** The tag indicators before the title of the tile for `item`. */
  tagIndicators(item: ItemRef): TagIndicators {
    const tile = this.tile(item);
    const win = this.grid.ownerDocument.defaultView!;
    const shown = Array.from(
      tile.querySelectorAll<HTMLElement>(".grid-view-tag:not([hidden])"),
      (indicator): TagIndicator => {
        const name = indicator.getAttribute("aria-label") ?? "";
        const emoji = indicator.textContent || undefined;
        if (emoji) return { name, emoji };
        const style = win.getComputedStyle(indicator);
        const colour = /currentcolor/i.test(style.fill)
          ? style.color
          : style.fill;
        return { name, colour };
      },
    );
    const overflow = tile.querySelector<HTMLElement>(".grid-view-tag-overflow");
    return {
      shown,
      overflow: overflow
        ? {
            text: overflow.textContent ?? "",
            names: (overflow.getAttribute("aria-label") ?? "").split("\n"),
          }
        : undefined,
    };
  }

  /** The item-type badge on the cover of the tile for `item`, if shown. */
  itemTypeBadge(item: ItemRef): ItemTypeBadge | undefined {
    const tile = this.tile(item);
    const badge = tile.querySelector<HTMLElement>(".grid-view-item-type-badge");
    if (!badge) return undefined;
    const win = this.grid.ownerDocument.defaultView!;
    const icon = badge.firstElementChild as HTMLElement | null;
    const bounds = badge.getBoundingClientRect();
    const cover = this.coverImage(item).parentElement!.getBoundingClientRect();
    return {
      label: badge.title,
      icon: icon ? win.getComputedStyle(icon).backgroundImage : "none",
      visible: bounds.width > 0 && bounds.height > 0,
      onCover:
        bounds.left >= cover.left &&
        bounds.right <= cover.right &&
        bounds.top >= cover.top &&
        bounds.bottom <= cover.bottom,
    };
  }

  /** Scroll the grid to `top`, as the user would. */
  scroll(top: number): void {
    this.grid.scrollTop = top;
    // Scroll events are asynchronous; deliver this one before continuing.
    this.grid.dispatchEvent(
      new this.grid.ownerDocument.defaultView!.Event("scroll"),
    );
  }

  /**
   * Scroll so that the top edge of the viewport is `offset` pixels below the
   * top of the tile for `item`. A negative offset leaves space above the tile.
   */
  scrollToTile(item: ItemRef, offset: number): void {
    const rect = this.tile(item).getBoundingClientRect();
    this.scroll(this.grid.scrollTop + rect.top - this.viewport().top + offset);
  }

  /**
   * Throw unless the mounted tiles are those near the viewport: they cover the
   * viewport, are contiguous in display order, and lie within two viewport
   * heights of it. The focused tile and the `exempt` items are not counted.
   */
  assertMountsNearViewport(exempt: ItemRef[] = []): void {
    const order = this.displayedItems();
    const mounted = this.mountedItems();
    const skipped = new Set(exempt.map(itemID));
    const focused = this.focusedItem();
    if (focused !== undefined) skipped.add(focused);
    const counted = mounted.filter((id) => !skipped.has(id));
    const fail = (problem: string) => {
      throw new Error(
        `Expected tiles to be mounted near the viewport only, but ${problem}. Mounted: ${describeValue(mounted)}`,
      );
    };
    if (!order.length) {
      if (counted.length) fail("no items are displayed");
      return;
    }
    if (!counted.length) fail("no tiles are mounted");
    const indexes = counted.map((id) => order.indexOf(id));
    if (indexes.includes(-1)) fail("some tiles show undisplayed items");
    const mountedIDs = new Set(mounted);
    // Exempt tiles adjoining the range still cover the viewport.
    let first = Math.min(...indexes);
    let last = Math.max(...indexes);
    while (first > 0 && mountedIDs.has(order[first - 1])) first--;
    while (last < order.length - 1 && mountedIDs.has(order[last + 1])) last++;
    const missing = order
      .slice(first, last + 1)
      .filter((id) => !mountedIDs.has(id));
    if (missing.length)
      fail(`items ${describeValue(missing)} in between are not mounted`);
    const viewport = this.viewport();
    const reach = 2 * (viewport.bottom - viewport.top);
    for (const id of counted) {
      const rect = this.tile(id).getBoundingClientRect();
      if (
        rect.bottom < viewport.top - reach ||
        rect.top > viewport.bottom + reach
      )
        fail(`item ${id} is more than two viewport heights away`);
    }
    if (
      first > 0 &&
      this.tile(order[first]).getBoundingClientRect().top > viewport.top
    )
      fail("tiles above the viewport's top edge are missing");
    if (
      last < order.length - 1 &&
      this.tile(order[last]).getBoundingClientRect().bottom < viewport.bottom
    )
      fail("tiles below the viewport's bottom edge are missing");
  }

  /** The grid's scrollport in client coordinates, excluding scrollbars. */
  protected viewport(): Box {
    const rect = this.grid.getBoundingClientRect();
    const top = rect.top + this.grid.clientTop;
    const left = rect.left + this.grid.clientLeft;
    return {
      top,
      bottom: top + this.grid.clientHeight,
      left,
      right: left + this.grid.clientWidth,
    };
  }

  private tiles(): HTMLElement[] {
    return Array.from(
      this.grid.querySelectorAll<HTMLElement>(".grid-view-item"),
    );
  }

  private visibleTiles(): { id: number; rect: DOMRect }[] {
    const viewport = this.viewport();
    return this.tiles()
      .map((tile) => ({
        id: Number(tile.dataset.itemId),
        rect: tile.getBoundingClientRect(),
      }))
      .filter(
        ({ rect }) =>
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom &&
          rect.right > viewport.left &&
          rect.left < viewport.right,
      );
  }
}

// Live grid view --------------------------------------------------------------

/** User-like actions and observations on one main window's grid view. */
export class GridWindow extends GridViewport {
  constructor(readonly win: _ZoteroTypes.MainWindow) {
    super();
  }

  get pane(): _ZoteroTypes.ZoteroPane {
    return this.win.ZoteroPane;
  }

  get grid(): HTMLElement {
    const grid = this.win.document.getElementById("cover-view-grid");
    if (!grid) throw new Error("The grid view is not attached to this window");
    return grid as HTMLElement;
  }

  /** The toolbar button switching between grid view and native item tree. */
  get toggleButton(): HTMLElement {
    return this.win.document.getElementById("cover-view-toggle") as HTMLElement;
  }

  /** Whether the toolbar button announces the grid view as switched on. */
  get togglePressed(): boolean {
    return this.toggleButton.getAttribute("aria-pressed") === "true";
  }

  /** The native item tree element. */
  get itemTree(): HTMLElement {
    return this.win.document.getElementById("zotero-items-tree") as HTMLElement;
  }

  /** Resolves once the grid view reflects the native item tree. */
  settled(): Promise<void> {
    return settled(this.win);
  }

  /** End the current resize gesture, as pausing after it would. */
  endResizeGesture(): void {
    plugin().testing.endResizeGesture(this.win);
  }

  /**
   * Set inline styles of the grid element, such as a fixed size, until the
   * end of the current test.
   */
  setStyle(styles: Record<string, string>): void {
    const style = this.grid.style;
    for (const [name, value] of Object.entries(styles)) {
      const previous = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      onTeardown(() => {
        if (previous) style.setProperty(name, previous, priority);
        else style.removeProperty(name);
      });
      style.setProperty(name, value);
    }
  }

  // Observations

  /** Whether the grid view, rather than the native item tree, is shown. */
  get showsGrid(): boolean {
    return !this.grid.hidden;
  }

  /** IDs of the top-level items in the native item tree, in displayed order. */
  displayedItems(): number[] {
    return (itemsView(this.pane).getSortedItems() as Zotero.Item[])
      .filter((item) => !item.parentItemID)
      .map((item) => item.id);
  }

  /** IDs of the items selected in the native item tree. */
  selectedItems(): number[] {
    return this.pane.getSelectedItems(true) as number[];
  }

  /** Whether the grid view owns keyboard focus. */
  get ownsFocus(): boolean {
    return this.win.document.activeElement === this.grid;
  }

  /** Whether the grid view is attached to this window. */
  get attached(): boolean {
    return !!this.win.document.getElementById("cover-view-grid");
  }

  /** Whether the native item tree is laid out in the window. */
  get showsItemTree(): boolean {
    return this.itemTree.getBoundingClientRect().height > 0;
  }

  /** Whether the native item tree owns keyboard focus. */
  get itemTreeOwnsFocus(): boolean {
    return this.itemTree.contains(this.win.document.activeElement);
  }

  /** The element owning keyboard focus, described for failure messages. */
  describeFocus(): string {
    const active = this.win.document.activeElement;
    return active ? describeElement(active) : "nothing";
  }

  /**
   * The native item tree rows at least partly inside its viewport, top to
   * bottom: their item, whether they are selected, and whether they are
   * entirely inside the viewport.
   */
  itemTreeRows(): {
    item?: number;
    selected: boolean;
    fullyVisible: boolean;
  }[] {
    const { viewport, rows } = this.itemTreeRowsInView();
    return rows.map(({ index, row, rect }) => ({
      item: this.itemTreeRowItem(index),
      selected: row.getAttribute("aria-selected") === "true",
      // Zotero may leave a revealed row clipped by a pixel or two.
      fullyVisible:
        rect.top >= viewport.top - 2 && rect.bottom <= viewport.bottom + 2,
    }));
  }

  /**
   * Whether the native item tree shows `item` as a selected row entirely
   * inside its viewport, with no blank gaps where rows belong.
   */
  itemTreeShowsSelected(item: ItemRef): boolean {
    return (
      this.itemTreeFilled() &&
      this.itemTreeRows().some(
        (row) => row.item === itemID(item) && row.selected && row.fullyVisible,
      )
    );
  }

  /**
   * Whether the rendered rows of the native item tree cover its viewport down
   * to its bottom edge or the last row, leaving no blank gaps.
   */
  private itemTreeFilled(): boolean {
    const { viewport, rows } = this.itemTreeRowsInView();
    const rowCount = itemsView(this.pane).rowCount;
    if (!rowCount) return true;
    if (!rows.length) return false;
    let covered = viewport.top;
    for (const { rect } of rows) {
      if (rect.top > covered + 1) return false;
      covered = Math.max(covered, rect.bottom);
    }
    return (
      covered >= viewport.bottom - 1 || rows.at(-1)!.index === rowCount - 1
    );
  }

  private itemTreeRowsInView(): {
    viewport: DOMRect;
    rows: { index: number; row: HTMLElement; rect: DOMRect }[];
  } {
    const viewport = (
      this.itemTree.querySelector(".virtualized-table-body") ?? this.itemTree
    ).getBoundingClientRect();
    const rows = Array.from(
      this.itemTree.querySelectorAll<HTMLElement>(".row"),
      (row) => ({
        // Zotero names rows after their index, such as `…-row-12`.
        index: Number(/-row-(\d+)$/.exec(row.id)?.[1] ?? NaN),
        row,
        rect: row.getBoundingClientRect(),
      }),
    )
      .filter(
        ({ rect }) =>
          rect.height > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom,
      )
      .sort((a, b) => a.rect.top - b.rect.top);
    return { viewport, rows };
  }

  private itemTreeRowItem(index: number): number | undefined {
    if (Number.isNaN(index)) return undefined;
    return (itemsView(this.pane).getRow(index)?.ref as Zotero.Item | undefined)
      ?.id;
  }

  /** Wait until the native item tree lists these items and the grid settled. */
  async showsItems(items: ItemRef[]): Promise<void> {
    await until(
      () => items.every((item) => this.displayedItems().includes(itemID(item))),
      `the native item tree to list ${items.map(describeItem).join(", ")}`,
      { observe: () => this.displayedItems() },
    );
    await this.settled();
  }

  // Native changes

  /** Select items in the native item tree, as other Zotero UI would. */
  async select(items: ItemRef[]): Promise<void> {
    if (items.length) await this.pane.selectItems(items.map(itemID));
    else itemsView(this.pane).selection.clearSelection();
    await this.settled();
  }

  /**
   * Select a collection tree row, such as `C12` for a collection or `S3` for
   * a saved search, and wait until the native item tree lists `items`.
   */
  async showRow(rowID: string, items: ItemRef[] = []): Promise<void> {
    await collectionsView(this.pane).selectByID(rowID);
    await until(
      () => selectedRow(this.pane) === rowID,
      `the collection tree row ${rowID} to be selected`,
    );
    await this.showsItems(items);
  }

  /**
   * Show the native item tree column labelled `label` until the end of the
   * current test.
   */
  showColumn(label: string): void {
    if (this.showsColumn(label)) return;
    const toggle = () =>
      this.columnOption(label).dispatchEvent(new this.win.Event("command"));
    onTeardown(() => {
      if (!this.win.closed && this.showsColumn(label)) toggle();
    });
    toggle();
  }

  /** Whether the native item tree shows the column labelled `label`. */
  showsColumn(label: string): boolean {
    return this.columnOption(label).getAttribute("checked") === "true";
  }

  private columnOption(label: string): Element {
    const picker = this.win.document.createXULElement("menupopup");
    (
      itemsView(this.pane) as _ZoteroTypes.ItemTree & {
        buildColumnPickerMenu(menu: Element): void;
      }
    ).buildColumnPickerMenu(picker);
    const option = picker.querySelector(`menuitem[label="${label}"]`);
    if (!option) throw new Error(`The item tree has no column "${label}"`);
    return option;
  }

  // User actions

  /**
   * Bring the tile for `item` into view, as the user would by selecting it
   * and scrolling to it from the grid view.
   */
  async reveal(item: ItemRef): Promise<void> {
    this.focusGrid();
    // The focused tile follows the selection and is always mounted.
    await this.select([item]);
    this.scrollToTile(item, 0);
    await this.settled();
  }

  /** Switch to the native item tree with the toolbar button. */
  async showList(): Promise<void> {
    if (this.showsGrid) this.pressToggle();
    await this.settled();
  }

  /** Switch to the grid view with the toolbar button. */
  async showGrid(): Promise<void> {
    if (!this.showsGrid) this.pressToggle();
    await this.settled();
  }

  /**
   * Open a reader tab for `item` in front of the library tab and return its
   * ID. It is closed when the current test ends.
   */
  async openReaderTab(item: ItemRef): Promise<string> {
    const tabs = this.win.Zotero_Tabs;
    const { id } = tabs.add({
      type: "reader",
      title: describeItem(item),
      data: { itemID: itemID(item) },
      select: true,
    });
    onTeardown(() => {
      if (tabs.selectedID === id) tabs.select("zotero-pane");
      tabs.close(id);
    });
    await this.selectTab(id);
    return id;
  }

  /** Switch to another tab, hiding the library tab. */
  async selectTab(id: string): Promise<void> {
    const tabs = this.win.Zotero_Tabs;
    tabs.select(id);
    await until(() => tabs.selectedID === id, `tab ${id} to be selected`);
  }

  /** Switch back to the library tab and wait for the grid view to settle. */
  async showLibraryTab(): Promise<void> {
    this.win.Zotero_Tabs.select("zotero-pane");
    await until(
      () => this.grid.clientWidth > 0,
      "the library tab to lay out the grid view",
    );
    await this.settled();
  }

  /** Press the toolbar button switching between grid view and item tree. */
  pressToggle(): void {
    restorePref("enableGridView");
    this.toggleButton.dispatchEvent(new this.win.Event("command"));
  }

  /**
   * Detach the grid view, as unloading the plugin from the window during a
   * hot reload does. It is attached again when the current test ends.
   */
  detach(): void {
    const hooks = plugin().hooks;
    onTeardown(() => {
      if (!this.win.closed && !this.attached) hooks.onMainWindowLoad(this.win);
    });
    hooks.onMainWindowUnload(this.win);
  }

  /** Attach the grid view again, as loading the plugin into the window does. */
  async attach(): Promise<void> {
    plugin().hooks.onMainWindowLoad(this.win);
    await this.settled();
  }

  /** Close this window, as the user would. */
  async close(): Promise<void> {
    if (this.attached) plugin().hooks.onMainWindowUnload(this.win);
    this.win.close();
    await until(() => this.win.closed, "the main window to close");
  }

  /** Move keyboard focus into the grid view. */
  focusGrid(): void {
    focus(this.grid);
  }

  /** Move keyboard focus into the native item tree. */
  focusItemTree(): void {
    focus(this.itemTree.querySelector("[role=tree]") ?? this.itemTree);
  }

  click(item: ItemRef, modifiers: Modifiers = {}): MouseEvent {
    return this.mouse(this.tile(item), "click", modifiers);
  }

  doubleClick(item: ItemRef, modifiers: Modifiers = {}): MouseEvent {
    return this.mouse(this.tile(item), "dblclick", modifiers);
  }

  contextMenu(item: ItemRef, modifiers: Modifiers = {}): MouseEvent {
    return this.mouse(this.tile(item), "contextmenu", modifiers);
  }

  /** Press a key while the grid view has keyboard focus. */
  press(
    key: string,
    modifiers: Modifiers & { code?: string } = {},
  ): KeyboardEvent {
    const event = new this.win.KeyboardEvent("keydown", {
      key,
      code: modifiers.code,
      bubbles: true,
      cancelable: true,
      ...this.modifierInit(modifiers),
    });
    this.grid.dispatchEvent(event);
    return event;
  }

  /** Turn the mouse wheel over the grid view. */
  wheel(
    deltaY: number,
    modifiers: Modifiers & { deltaMode?: number } = {},
  ): WheelEvent {
    restorePref("tileSize");
    const event = new this.win.WheelEvent("wheel", {
      deltaY,
      deltaMode: modifiers.deltaMode ?? 0,
      bubbles: true,
      cancelable: true,
      ...this.modifierInit(modifiers),
    });
    this.grid.dispatchEvent(event);
    return event;
  }

  // Drag and drop

  /** Data dragged from the file manager: these files, in order. */
  fileTransfer(paths: string[]): DataTransfer {
    const files = paths.map((path) => Zotero.File.pathToFile(path));
    if (files.length > 1) {
      // A constructed DataTransfer cannot hold more than one item.
      const types = ["application/x-moz-file", "Files"];
      return {
        types,
        mozItemCount: files.length,
        mozGetDataAt: (type: string, index: number) =>
          type === "application/x-moz-file" ? files[index] : null,
        mozTypesAt: () => types,
        getData: () => "",
        dropEffect: "none",
        effectAllowed: "all",
      } as unknown as DataTransfer;
    }
    const transfer = new this.win.DataTransfer();
    for (const file of files)
      transfer.mozSetDataAt("application/x-moz-file", file, 0);
    return transfer;
  }

  /** Data dragged from another Zotero item tree: these items. */
  itemTransfer(items: ItemRef[]): DataTransfer {
    const transfer = new this.win.DataTransfer();
    transfer.setData("zotero/item", items.map(itemID).join(","));
    // As Zotero's item drags allow; a new transfer allows no effect at all.
    transfer.effectAllowed = "copyMove";
    return transfer;
  }

  /** The native item tree row of `item`, scrolled into view. */
  itemRow(item: ItemRef): HTMLElement {
    const view = itemsView(this.pane) as _ZoteroTypes.ItemTree & {
      tree: { getRowElement(index: number): HTMLElement | null };
    };
    const index = view.getRowIndexByID(String(itemID(item)));
    if (index === false)
      throw new Error(
        `The native item tree has no row for ${describeItem(item)}`,
      );
    view.ensureRowIsVisible(index);
    const row = view.tree.getRowElement(index);
    if (!row)
      throw new Error(
        `The native item tree row of ${describeItem(item)} is not rendered`,
      );
    return row;
  }

  /**
   * The image URIs shown in the Cover column cell of `item`'s native item
   * tree row. Only one is shown once the cell is up to date.
   */
  coverColumnCovers(item: ItemRef): string[] {
    return Array.from(
      this.itemRow(item).querySelectorAll<HTMLImageElement>('img[alt="Cover"]'),
      (image) => image.getAttribute("src") ?? "",
    );
  }

  /** The collection tree row of `collection`, scrolled into view. */
  collectionRow(collection: Zotero.Collection): HTMLElement {
    const view = collectionsView(this.pane) as _ZoteroTypes.CollectionTree & {
      tree: { getRowElement(index: number): HTMLElement | null };
      ensureRowIsVisible(index: number): void;
    };
    const index = view.getRowIndexByID(`C${collection.id}`);
    if (index === false || index === undefined)
      throw new Error(
        `The collection tree has no row for "${collection.name}"`,
      );
    view.ensureRowIsVisible(index);
    const row = view.tree.getRowElement(index);
    if (!row)
      throw new Error(
        `The collection tree row of "${collection.name}" is not rendered`,
      );
    return row;
  }

  /**
   * Start dragging the tile for `item`, as the user would. Returns the
   * dragged data, or `undefined` if the grid refused to start the drag. The
   * drag ends when the test calls `endDrag` or when the test ends.
   */
  startDrag(
    item: ItemRef,
    modifiers: Modifiers = {},
  ): DataTransfer | undefined {
    const transfer = new this.win.DataTransfer();
    const tile = this.tile(item);
    this.dragSource = tile;
    const start = this.dragEvent(tile, "dragstart", transfer, modifiers);
    if (!start.defaultPrevented) return transfer;
    this.endDrag();
    return undefined;
  }

  /**
   * Move dragged data over `target`: an item's tile, grid whitespace, or
   * another element such as a tree row. The pointer is at the target's
   * centre. Returns whether the target would accept a drop, and with which
   * effect.
   */
  dragOver(
    target: DragTarget,
    transfer: DataTransfer,
    modifiers: Modifiers = {},
  ): { accepted: boolean; dropEffect: string } {
    const over = this.dragEvent(
      this.dragTarget(target),
      "dragover",
      transfer,
      modifiers,
    );
    return {
      accepted: over.defaultPrevented && transfer.dropEffect !== "none",
      dropEffect: transfer.dropEffect,
    };
  }

  /**
   * Drop dragged data on `target`, even if the last `dragOver` was refused.
   * Returns whether the grid took the drop; tree rows never report this.
   */
  drop(
    target: DragTarget,
    transfer: DataTransfer,
    modifiers: Modifiers = {},
  ): boolean {
    const drop = this.dragEvent(
      this.dragTarget(target),
      "drop",
      transfer,
      modifiers,
    );
    return drop.defaultPrevented && transfer.dropEffect !== "none";
  }

  /** Move the dragged pointer off `from` to `to`, or out of the window. */
  dragLeave(from: DragTarget, to: DragTarget | null = null): void {
    const leave = new this.win.MouseEvent("dragleave", {
      bubbles: true,
      relatedTarget: to === null ? null : this.dragTarget(to),
    });
    this.dragTarget(from).dispatchEvent(leave);
  }

  /** End the current drag, as releasing or cancelling it does. */
  endDrag(): void {
    const source = this.dragSource?.isConnected
      ? this.dragSource
      : this.win.document;
    this.dragSource = undefined;
    source.dispatchEvent(new this.win.Event("dragend", { bubbles: true }));
  }

  /**
   * Drag `source` (an item's tile, or other data) over `target` and drop it
   * there if the target accepts it, then end the drag.
   */
  drag(
    source: ItemRef | DataTransfer,
    target: DragTarget,
    modifiers: Modifiers = {},
  ): { accepted: boolean; dropEffect: string; transfer: DataTransfer } {
    const transfer =
      typeof source === "object" && !(source instanceof Zotero.Item)
        ? source
        : this.startDrag(source, modifiers);
    if (!transfer)
      return {
        accepted: false,
        dropEffect: "none",
        transfer: new this.win.DataTransfer(),
      };
    const { accepted, dropEffect } = this.dragOver(target, transfer, modifiers);
    if (accepted) this.drop(target, transfer, modifiers);
    this.endDrag();
    return { accepted, dropEffect, transfer };
  }

  private dragSource?: HTMLElement;
  private dragging = false;

  private dragTarget(target: DragTarget): Element {
    if (target === "whitespace") return this.grid;
    if (typeof target === "number" || target instanceof Zotero.Item)
      return this.tile(target);
    return target;
  }

  /** End an unfinished drag and restore Zotero's drag state after the test. */
  private trackDrag(): void {
    if (this.dragging) return;
    this.dragging = true;
    const dragDrop = (
      Zotero as unknown as { DragDrop: Record<string, unknown> }
    ).DragDrop;
    const saved = {
      currentDragSource: dragDrop.currentDragSource,
      currentOrientation: dragDrop.currentOrientation,
      currentDropEffect: dragDrop.currentDropEffect,
    };
    onTeardown(() => {
      this.dragging = false;
      if (!this.win.closed) this.endDrag();
      Object.assign(dragDrop, saved);
    });
  }

  private mouse(
    element: Element,
    type: string,
    modifiers: Modifiers,
  ): MouseEvent {
    const event = new this.win.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...this.modifierInit(modifiers),
    });
    element.dispatchEvent(event);
    return event;
  }

  private dragEvent(
    element: Element,
    type: string,
    transfer: DataTransfer,
    modifiers: Modifiers,
  ): DragEvent {
    this.trackDrag();
    const rect = element.getBoundingClientRect();
    const event = new this.win.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...this.modifierInit(modifiers),
    }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    element.dispatchEvent(event);
    return event;
  }

  private modifierInit(modifiers: Modifiers) {
    const mac = this.win.navigator.platform.startsWith("Mac");
    return {
      shiftKey: !!modifiers.shift,
      altKey: !!modifiers.alt,
      ctrlKey: !!modifiers.ctrl || (!!modifiers.primary && !mac),
      metaKey: !!modifiers.meta || (!!modifiers.primary && mac),
    };
  }
}

/** The live grid view of the main window, showing a fresh collection. */
export class GridFixture extends GridWindow {
  constructor(
    win: _ZoteroTypes.MainWindow,
    readonly collection: Zotero.Collection,
    /** Items created for the collection, in creation order. */
    readonly items: Zotero.Item[],
  ) {
    super(win);
  }

  /** The fixture item with this ID. */
  itemByID(id: number): Zotero.Item {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Item ${id} is not a fixture item`);
    return item;
  }

  /** Add items to the fixture's collection and wait for their tiles. */
  async addItems(specs: number | ItemSpec[]): Promise<Zotero.Item[]> {
    const added = await createItems(specs, this.collection);
    this.items.push(...added);
    await this.showsItems(added);
    return added;
  }

  /**
   * Open another Zotero main window showing the fixture's collection. It is
   * closed when the current test ends.
   */
  async openWindow(): Promise<GridWindow> {
    const view = await openMainWindow();
    await collectionsView(view.pane).selectByID(`C${this.collection.id}`);
    await view.showsItems(this.items);
    return view;
  }
}

/**
 * Hold the next native selection write of `view` until the test releases,
 * rejects or discards it. Discarding resolves the write without applying it.
 * Later writes pass through.
 */
export function holdNextSelectionWrite(view: GridWindow) {
  const pane = view.pane;
  const selectItems = pane.selectItems;
  let held = false;
  let settle!: (apply: boolean) => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<boolean>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  patch(
    pane,
    "selectItems",
    async (...args: Parameters<typeof selectItems>) => {
      if (held) return selectItems.apply(pane, args);
      held = true;
      if (await gate) return selectItems.apply(pane, args);
      return true;
    },
  );
  return {
    reached: () =>
      until(() => held, "the grid view to write a native selection"),
    release: () => settle(true),
    reject,
    discard: () => settle(false),
  };
}

/**
 * Activate the main window and show its grid view (or native item tree) for a
 * fresh collection containing `items`. Restores the view mode, the selected
 * collection and its selection after the test.
 */
export async function openGrid({
  items = [],
  view = "grid",
  libraryID,
}: {
  items?: number | ItemSpec[];
  view?: "grid" | "list";
  /** The library holding the collection; defaults to the user library. */
  libraryID?: number;
} = {}): Promise<GridFixture> {
  const win = mainWindow();
  const pane = win.ZoteroPane;
  const previousRow = selectedRow(pane);
  const previousSelection = pane.getSelectedItems(true) as number[];
  onTeardown(async () => {
    if (previousRow && selectedRow(pane) !== previousRow)
      await collectionsView(pane).selectByID(previousRow);
    const existing = previousSelection.filter((id) => Zotero.Items.get(id));
    if (existing.length) await pane.selectItems(existing);
    else itemsView(pane).selection.clearSelection();
  });
  setPref("enableGridView", view === "grid");
  // Hidden windows load no covers and paint no frames.
  focusWindow(win);
  const collection = await createCollection(undefined, libraryID);
  const created = await createItems(items, collection);
  await collectionsView(pane).selectByID(`C${collection.id}`);
  const fixture = new GridFixture(win, collection, created);
  await fixture.showsItems(created);
  return fixture;
}

/**
 * Show an empty collection in the main window until the end of the current
 * test, so that the live plugin neither displays items created outside a
 * grid fixture nor looks up their covers.
 */
export async function showEmptyCollection(): Promise<void> {
  const pane = mainWindow().ZoteroPane;
  if (state.emptyRow && selectedRow(pane) === state.emptyRow) {
    // Tests can still select another row; the fixture should then restore it.
    onTeardown(async () => {
      if (selectedRow(pane) !== state.emptyRow)
        await collectionsView(pane).selectByID(state.emptyRow!);
    });
    return;
  }
  await openGrid();
}

// Plugin lifecycle ------------------------------------------------------------

/**
 * Shut the plugin down, as disabling it does, and return a function starting
 * it again, as re-enabling it does. It is started again when the current
 * test ends.
 */
export function shutDownPlugin(): () => Promise<void> {
  const instance = plugin();
  let running = true;
  const start = async () => {
    if (running) return;
    running = true;
    // Temporarily installed add-ons are not registered again by Zotero.
    (Zotero as unknown as Record<string, Plugin>)[config.addonInstance] =
      instance;
    instance.data.alive = true;
    await instance.hooks.onStartup();
  };
  onTeardown(start);
  instance.hooks.onShutdown();
  running = false;
  return start;
}

// Extra windows ---------------------------------------------------------------

/**
 * Open another Zotero main window with its own grid view. It is closed when
 * the current test ends.
 */
export async function openMainWindow(): Promise<GridWindow> {
  const existing = new Set(Zotero.getMainWindows());
  let opened: _ZoteroTypes.MainWindow | undefined;
  onTeardown(async () => {
    if (opened && !opened.closed) await new GridWindow(opened).close();
  });
  Zotero.openMainWindow();
  await until(() => {
    opened = Zotero.getMainWindows().find(
      (win) => !existing.has(win) && !win.closed,
    );
    return (
      !!opened?.ZoteroPane?.loaded &&
      !!opened.ZoteroPane.itemsView &&
      !!opened.ZoteroPane.collectionsView
    );
  }, "a new Zotero main window to load");
  await collectionsView(opened!.ZoteroPane).waitForLoad();
  await itemsView(opened!.ZoteroPane).waitForLoad();
  const view = new GridWindow(opened!);
  // Temporarily installed add-ons do not receive new-window hooks.
  if (!view.attached) plugin().hooks.onMainWindowLoad(opened!);
  await view.settled();
  return view;
}

/**
 * Open the Zotero settings window on the plugin's pane. It is closed when the
 * current test ends.
 */
export async function openPreferences(): Promise<Window> {
  const pane = Zotero.PreferencePanes.pluginPanes.find(
    (entry) => entry.pluginID === config.addonID,
  );
  if (!pane) throw new Error("The plugin's settings pane is not registered");
  const opened = Zotero.Utilities.Internal.openPreferences(pane.id!) as Window;
  onTeardown(async () => {
    if (opened.closed) return;
    opened.close();
    await until(() => opened.closed, "the settings window to close");
  });
  await until(
    () =>
      opened.document?.getElementById(
        `zotero-prefpane-${config.addonRef}-enable-grid-view`,
      ),
    "the plugin's settings pane to load",
  );
  return opened;
}

// Standalone renderer ---------------------------------------------------------

export interface DisplayItemSpec {
  title?: string;
  creator?: string;
  /** A date such as `2026-01-01`, shown as the year caption. */
  date?: string;
  /**
   * Make the item a standalone image attachment whose cover file path is
   * resolved by this function whenever the renderer looks up the cover.
   */
  imagePath?: () => Promise<string>;
}

/** Track sizes and spacing of a standalone renderer's host. */
export interface RendererLayout {
  /** A fixed number of tile-sized columns, or as many as fit the width. */
  columns?: number | "auto-fill";
  tileSize?: number;
  width?: number;
  height?: number;
  /** CSS padding, such as `19px 23px`. */
  padding?: string;
  /** CSS gap between rows and columns, such as `31px 17px`. */
  gap?: string;
}

export interface RendererOptions extends RendererLayout {
  /** Display-only items with IDs -1, -2, …; defaults to none. */
  items?: number | DisplayItemSpec[];
  render?: Partial<GridRenderOptions>;
  onSelect?: (itemID: number, modifiers: GridSelectionModifiers) => void;
  onActivate?: (itemID: number) => void;
  onNavigate?: (
    command: GridNavigationCommand,
    modifiers: GridSelectionModifiers,
  ) => void;
  onFocus?: () => void;
  onItemCommand?: (
    command: GridItemCommand,
    options: GridItemCommandOptions,
  ) => void;
  onContextMenu?: (itemID: number, screenX: number, screenY: number) => void;
  onDragStart?: (itemID: number, event: DragEvent) => void;
}

/**
 * Display-only items that never touch the database, with IDs counting down
 * from `-first`.
 */
export function displayItems(
  specs: number | DisplayItemSpec[],
  first = 1,
): Zotero.Item[] {
  const list: DisplayItemSpec[] =
    typeof specs === "number" ? Array(specs).fill({}) : specs;
  return list.map((spec, index) => {
    const title = spec.title ?? `Display item ${index + first}`;
    const item = {
      id: -(index + first),
      firstCreator: spec.creator ?? "",
      getDisplayTitle: () => title,
      getField: (field: string) =>
        field === "title" ? title : field === "date" ? (spec.date ?? "") : "",
      isFileAttachment: () => !!spec.imagePath,
      isRegularItem: () => false,
    };
    if (spec.imagePath)
      Object.assign(item, {
        itemType: "attachment",
        attachmentContentType: "image/png",
        getFilePathAsync: spec.imagePath,
      });
    return item as unknown as Zotero.Item;
  });
}

function layoutStyles(layout: RendererLayout): Record<string, string> {
  const styles: Record<string, string> = {};
  if (layout.columns !== undefined)
    styles["grid-template-columns"] =
      layout.columns === "auto-fill"
        ? "repeat(auto-fill,minmax(var(--cover-view-tile-size),1fr))"
        : `repeat(${layout.columns},var(--cover-view-tile-size))`;
  if (layout.tileSize !== undefined)
    styles["--cover-view-tile-size"] = `${layout.tileSize}px`;
  if (layout.width !== undefined) styles.width = `${layout.width}px`;
  if (layout.height !== undefined) styles.height = `${layout.height}px`;
  if (layout.padding !== undefined) styles.padding = layout.padding;
  if (layout.gap !== undefined) styles.gap = layout.gap;
  return styles;
}

/** A grid renderer on its own sized host, outside the live grid view. */
export class RendererFixture extends GridViewport {
  constructor(
    readonly host: HTMLElement,
    public renderer: GridRenderer,
    /** The displayed items, in display order. */
    public items: Zotero.Item[],
    public render: GridRenderOptions,
  ) {
    super();
  }

  get grid(): HTMLElement {
    return this.host;
  }

  displayedItems(): number[] {
    return this.items.map((item) => item.id);
  }

  /** Display other items, as a sort, filter or collection change would. */
  setItems(
    items: Zotero.Item[],
    render: Partial<GridRenderOptions> = {},
  ): void {
    this.items = items;
    this.render = { ...this.render, ...render };
    this.renderer.setItems(items, this.render);
  }

  /**
   * Change the layout through an explicit layout refresh, as a tile size
   * change does.
   */
  resize(layout: RendererLayout): void {
    this.renderer.refreshLayout(() => this.setStyle(layoutStyles(layout)));
  }

  /**
   * Change the layout without notifying the renderer, as resizing the window
   * does, and wait for the renderer to notice.
   */
  async restyle(layout: RendererLayout): Promise<void> {
    this.setStyle(layoutStyles(layout));
    // Style mutations are observed in a microtask queued before this one.
    await Promise.resolve();
  }

  /** Set inline styles of the host and wait for the renderer to notice. */
  async setHostStyle(styles: Record<string, string>): Promise<void> {
    this.setStyle(styles);
    await Promise.resolve();
  }

  /** Hide the grid, as switching to another tab does. */
  hide(): void {
    this.host.style.display = "none";
    this.renderer.refreshLayout();
  }

  /** Show the grid again, as returning to the library tab does. */
  show(): void {
    this.host.style.display = "grid";
    this.renderer.refreshLayout();
  }

  /** End the current resize gesture, as pausing after it would. */
  endResizeGesture(): void {
    this.renderer.endResizeGesture();
  }

  /** Resolves once the covers of mounted tiles have been shown or failed. */
  coversSettled(): Promise<void> {
    return this.renderer.coversSettled();
  }

  private setStyle(styles: Record<string, string>): void {
    for (const [name, value] of Object.entries(styles))
      this.host.style.setProperty(name, value);
  }
}

/**
 * A grid renderer on its own sized host outside the live grid view, in a
 * fixed position so that its tiles intersect the window's viewport. It is
 * destroyed when the current test ends.
 */
export function createRenderer({
  items = 0,
  render = {},
  columns = 3,
  tileSize = 180,
  width = 600,
  height = 600,
  padding,
  gap,
  ...callbacks
}: RendererOptions = {}): RendererFixture {
  // The test bundle's copy of the renderer reads strings through `addon`.
  if (!("addon" in globalThis)) {
    Object.defineProperty(globalThis, "addon", {
      value: plugin(),
      configurable: true,
    });
    onTeardown(() => {
      Reflect.deleteProperty(globalThis, "addon");
    });
  }
  const doc = mainWindow().document;
  const wrapper = doc.createElement("div");
  wrapper.style.cssText = "position:fixed;top:0;left:0";
  const host = doc.createElement("div");
  host.style.cssText =
    "display:grid;box-sizing:border-box;overflow:auto;align-content:start";
  for (const [name, value] of Object.entries(
    layoutStyles({ columns, tileSize, width, height, padding, gap }),
  ))
    host.style.setProperty(name, value);
  wrapper.append(host);
  doc.documentElement!.append(wrapper);
  const renderer = new GridRenderer(
    host,
    callbacks.onSelect ?? (() => {}),
    callbacks.onActivate,
    callbacks.onNavigate,
    callbacks.onFocus,
    callbacks.onItemCommand,
    callbacks.onContextMenu,
    callbacks.onDragStart,
  );
  const fixture = new RendererFixture(host, renderer, [], {
    showCreators: true,
    ...render,
  });
  onTeardown(() => {
    fixture.renderer.destroy();
    wrapper.remove();
  });
  const displayed = displayItems(items);
  if (displayed.length) fixture.setItems(displayed);
  return fixture;
}
