# Cover View for Zotero

[![zotero target version](https://img.shields.io/badge/Zotero-10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Cover View is an extension for [Zotero](https://www.zotero.org) that offers an alternative cover grid view next to the default list view for Zotero items.
This makes it more visually appealing especially for books (as opposed to academic papers).

## Features

- **Cover extraction**
  - uses an attached image or the first page of an attached `.epub` or `.pdf` file as cover
- **Grid view**
  - display items in a grid instead of a list
  - adds a button to the main item bar to switch between grid view and list view
- **List view**: provides 'Cover' column with thumbnail of cover

## Installation

- Download the latest release (`.xpi` file) from:
  - [Latest Stable](https://github.com/paulluis-roehl/zotero-cover-view/releases/latest)
  - [All Releases](https://github.com/paulluis-roehl/zotero-cover-view/releases)

  _Note_: If you're using Firefox as your browser, right click the `.xpi` and select `Save Link As...`.

- In Zotero click `Tools` in the top menu bar and then click `Plugins`
- Click the gear icon in the top right of the Plugins Manager.
- Select `Install Plugin From File`.
- Browse to where you downloaded the `.xpi` file and select it.
- Done!

## Todo

**Covers**

- [x] support `.pdf`
- [x] support `.epub`
- [x] support `.jpg` / `.png`
- [ ] support `.djvu`
- [x] auto-generate default cover based on title
- [ ] try to fetch cover from internet
- [ ] implement precedence setting

**Grid view**

- [x] single click select
- [x] double click open
- [ ] multi-select (`shift + click` and `ctrl + click`)
- [ ] right click menu
- [ ] general keyboard input and shortcuts
  - [ ] adjust arrow keys for grid navigation
- [ ] drag and drop files into grid view

**Settings**

- [ ] grid size
- [ ] grid item aspect ratio
  - update in `coverView.css` and also `placeholderCover.ts` default cover svg
- [ ] further display options for grid view (e.g. title, author, year, ...)
- [x] remember previous choice of list vs grid view
  - [ ] option for separate choice in every collection

**UI/UX**

- [x] button for switching between list and grid view
  - [x] improve svg icons
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

**Bugs**

- [ ] fix: pdf cover renders incorrectly in some cases (with "old" / scanned text)
- [ ] fix: placeholder cover doesn't update when metadata changed
- [ ] fix: focus
  - clicking on collection, then grid does not shift focus from selected collection
  - when switching back to list view, selection renders as "stale" (gray) rather than focused
- [ ] fix: when selecting book through grid view and then disabling plugin, only two items above the book render in list view (rest is white space)
  - when selecting that same book through list view, then switching to grid view and doing the same, everything works as intended
  - just switching to list view and back fixes it as well

<br/>

This plugin is based on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template).
See setup and debug details there.

## Acknowledgements

- Based on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) by [@windingwind](https://github.com/windingwind).
- Inspired by [this](https://forums.zotero.org/discussion/121736/feature-request-cover-flow-or-book-jacket-image-display-view) discussion on the Zotero forum.
- Implementation also inspired by [zotero-lib-view](https://github.com/reiherj/zotero-lib-view).

## Disclaimer

This project is licensed under the AGPL-3.0 and is provided as-is, without any warranties or guarantees.
