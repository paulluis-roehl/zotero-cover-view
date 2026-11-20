# Test conventions

Tests run inside Zotero (`npm test -- --no-watch`), one file after another in
alphabetical order, in one Zotero session. Every test must pass alone and in any
order. To run some files only, point `COVER_VIEW_TEST_ENTRIES` at a directory
holding them (symlinks work):

```sh
mkdir -p /tmp/cover-view-entries
ln -s "$PWD/test/gridSelection.test.ts" /tmp/cover-view-entries/
COVER_VIEW_TEST_ENTRIES=/tmp/cover-view-entries npm test -- --no-watch
```

Organise test files by user-visible behaviour, named with `CONTEXT.md` terms
(selection and focused tile, keyboard navigation, tile captions, current
cover, …). Test each behaviour in one place, and name tests after the
behaviour, not after a bug.

## Grid fixture (`test/helpers/gridFixture.ts`)

The default seam. `openGrid({ items })` shows the live grid view of the main
window for a fresh collection holding only the given items, and returns a
`GridFixture`:

- address tiles by item (`grid.tile(item)`), never by position;
- act as a user would: `click`, `press`, `contextMenu`, `wheel`, `drag`,
  `showList`/`showGrid`, `openWindow`, …;
- observe what a user sees: `selectedItems()`, `focusedItem()`,
  `visibleItems()`, `captionLines()`, `currentCover()`, `accessibleName()`, …

Everything the fixture touches is restored by root hooks after every test,
even a failing one: created items and collections, prefs (`setPref`), patched
globals (`patch`), view mode, selected collection and selection, extra windows,
tabs and renderers. Register further cleanups with `onTeardown`. Tests need no
`try`/`finally`.

Rules:

- Create many items in one batch (`openGrid({ items: 90 })`, `createItems`).
- Stub `Zotero.HTTP.request` only through the test environment's Open Library
  interceptors, which leave the test runner's own requests alone.
- Never patch plugin module statics: each test file bundles its own copy of
  the plugin modules, so the live plugin would not see the patch.
- Get window focus with `focusWindow`/`focus`/`blurWindow`, and open windows
  with `openWindow`/`openMainWindow`/`openPreferences`.

For the whole run, the main window shows an empty collection and the database
skips syncing to disk on each commit; both are undone when the run ends.

## Renderer fixture (`test/helpers/gridFixture.ts`)

`createRenderer({ items, columns, tileSize, … })` builds a grid renderer on a
detached, sized host with invented display items. Use it only for geometry and
virtualization behaviour that is hard to reach through the live grid view, such
as the viewport anchor across many layout changes.

## Test environment (`test/helpers/testEnvironment.ts`)

- `scratchDirectory`/`scratchFile`: files under a per-run
  `zotero-cover-view-*` directory in the OS temp directory, removed after the run;
- `imageBytes`, `pdfBytes`, `epubBytes`: generated PNG/JPEG images, minimal
  PDFs (optionally with custom page contents, objects and further pages) and
  real EPUB archives;
- `imageSize`, `imagePaint`: an image's natural size, and its average colour
  and share of non-white pixels;
- `inventBook`: invented titles, creators, years and publishers;
- `uniqueISBN`, `uniqueEditionKey`: per-test identifiers that name no real
  book (ISBNs in group 979-5) and are removed from the cover cache after the
  run;
- `interceptOpenLibrary`/`fakeOpenLibrary`: answer only Open Library requests,
  pass the rest through, and are always restored.

Never use real titles, real ISBNs or paths in the Zotero data directory.

## Waiting

- `await grid.settled()` (or `settled(win)`) resolves once the window's grid
  view reflects the native item tree: no pending sync, selection mirrored,
  focused tile applied, and covers of mounted tiles resolved. Await it after
  every change before asserting, including before asserting that nothing
  happened. It does not wait for covers while the window is hidden, so
  `openGrid` activates the main window; activate other windows with
  `focusWindow` before asserting their covers.
- `until(condition, description, { observe })` waits for anything `settled`
  does not cover, such as native focus or files on disk. On timeout it names
  what was awaited and the last observed state.
- `grid.endResizeGesture()` ends a resize gesture instead of waiting for the
  gesture pause.
- No fixed sleeps. The only waits for a frame (`painted`) are where Zotero
  offers no observable signal:
  - `gridNativeRestoration.test.ts`, "leaves focus in another pane when the
    grid view is detached": the grid view is detached, so `settled` is
    unavailable, and focus must stay put.
  - `itemPaneCover.test.ts`, "doesn't jump while a pinned section stays in
    place across cover changes": the Item Pane lays out pinned sections on
    animation frames without an event.
  - `coverColumn.test.ts`, "shows only the current cover when an earlier
    online lookup finishes late": the native item tree redraws the Cover
    column on a frame, and the test asserts that it did not change.

## Assertions

Assert observable state only: the native selection, the focused tile, visible
items, caption text, accessible names, the current cover's kind, items and
files created in Zotero, and pref values. Geometry only as relations (same
row, visible or not, order). No exact pixels or coordinates, CSS classes,
inline styles, SVG attributes, internal constants, call counts or call order.
Compare visual features coarsely, such as an online-sourced cover painting
visibly different from an attachment-derived one.
