## Todo

**Covers**

- [ ] support `.djvu`
- [ ] implement precedence setting

**Grid view**

**Settings**

- [x] grid size
- [ ] grid item aspect ratio
  - update in `coverView.css` and also `placeholderCover.ts` default cover svg
- [ ] save fetched cover(s) as attachment (maybe also in right click menu) (warning: in large libraries, this may create a lot of attachments)

**UI/UX**

- [ ] hot key for switching between list and grid view
- [ ] add cover section to item info view
- [ ] improve graphics / effects while loading covers
- [ ] add cover flow pane

**Implementation**

- [ ] switch from `ZoteroToolkit` to custom (smaller) tool kit
- [ ] can / should I extract grid view into a `.xhtml` file?
- [ ] move `DEFAULT_COVER_WIDTH` and `DEFAULT_PAGE_WIDTH` from `pdfCover.ts` into settings
- [ ] move `CHUNK_SIZE` from `gridRenderer.ts` into (advanced) settings
- [ ] add `peekCover()` function for immediate display of already cached covers
- [x] make ISBN cover toggle refresh the grid renderer
  - [ ] only target items that actually need refreshing
  - maybe give coverProvider a way to notify about a change and request that specific item to be re-rendered?
- [ ] check [ZoteroThumbLibrary](https://github.com/gchapron/ZoteroThumbLibrary) for improvements to current architecture

**Bugs**

- [ ] fix: when selecting book through grid view and then disabling plugin, only two items above the book render in list view (rest is white space)
  - when selecting that same book through list view, then switching to grid view and doing the same, everything works as intended
  - just switching to list view and back fixes it as well
- [ ] fix: when lazy-loading grid view, scrollbar does not account for all items
  - (maybe items themselves shouldn't be lazy-loaded, only covers)

<br/>

This plugin is based on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template).
See setup and debug details there.


