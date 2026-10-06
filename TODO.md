## Todo

**Covers**

- [x] support `.pdf`
- [x] support `.epub`
- [x] support `.jpg` / `.png`
- [ ] support `.djvu`
- [x] auto-generate default cover based on title
- [x] try to fetch cover from internet (based on isbn)
  - [x] extend to include non-isbn metadata
- [ ] implement precedence setting

**Grid view**

- [x] single click select
- [x] double click open
- [x] multi-select (`shift + click` and `ctrl + click`)
- [x] right click menu
- [x] general keyboard input and shortcuts
  - [x] adjust arrow keys for grid navigation
- [x] drag and drop files into grid view

**Settings**

- [x] grid size
- [ ] grid item aspect ratio
  - update in `coverView.css` and also `placeholderCover.ts` default cover svg
- [x] further display options for grid view (e.g. title, author, year, ...)
- [x] remember previous choice of list vs grid view
  - [ ] option for separate choice in every collection
- [ ] save fetched cover(s) as attachment (maybe also in right click menu) (warning: in large libraries, this may create a lot of attachments)

**UI/UX**

- [x] button for switching between list and grid view
  - [x] improve svg icons
- [ ] hot key for switching between list and grid view
- [ ] add cover section to item info view
- [ ] improve graphics / effects while loading covers
- [x] make cover column small and with icon, just like the Attachments column
- [ ] add cover flow pane
- [x] visually distinguish fetched missing covers from actual attachments (+ settings option)
  - e.g. decrease opacity

**Implementation**

- [ ] switch from `ZoteroToolkit` to custom (smaller) tool kit
- [ ] can / should I extract grid view into a `.xhtml` file?
- [ ] move `DEFAULT_COVER_WIDTH` and `DEFAULT_PAGE_WIDTH` from `pdfCover.ts` into settings
- [ ] move `CHUNK_SIZE` from `gridRenderer.ts` into (advanced) settings
- [ ] add `peekCover()` function for immediate display of already cached covers
- [x] make ISBN cover toggle refresh the grid renderer
  - [ ] only target items that actually need refreshing
  - maybe give coverProvider a way to notify about a change and request that specific item to be re-rendered?
- [x] refresh covers when metadata changes (for ISBN or auto-generated)
- [x] add Open Library request scheduler that:
  - Limits concurrent network requests, likely to 2-3.
  - Enforces the documented 100 requests per 5-minute window.
  - Prioritizes or only starts lookups for near-viewport tiles.
  - Continues using positive and negative disk caches.
  - Handles 403/429 responses with backoff rather than treating them as missing covers.
- Open Library request scheduler:
  - [ ] provide placeholder while searching

**Bugs**

- [>] fix: pdf cover renders incorrectly in some cases (with "old" / scanned text)
- [x] fix: placeholder cover doesn't update when metadata changed
- [x] fix: focus
  - [x] clicking on collection, then grid should shift focus from selected collection
  - [x] when switching back to list view, selection renders as "stale" (gray) rather than focused
  - [x] when focussing on something else, grid selection should become "stale" (gray)
- [ ] fix: when selecting book through grid view and then disabling plugin, only two items above the book render in list view (rest is white space)
  - when selecting that same book through list view, then switching to grid view and doing the same, everything works as intended
  - just switching to list view and back fixes it as well
- [ ] fix: when lazy-loading grid view, scrollbar does not account for all items
  - (maybe items themselves shouldn't be lazy-loaded, only covers)

<br/>

This plugin is based on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template).
See setup and debug details there.


