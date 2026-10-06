# Cover View for Zotero

[![zotero target version](https://img.shields.io/badge/Zotero-10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Cover View is an extension for [Zotero](https://www.zotero.org) that offers an alternative cover grid view next to the default list view for Zotero items.
This makes it more visually appealing especially for books (as opposed to academic papers).

## Features

- **Cover extraction options**
  - image attachment
  - first page of `.epub` or `.pdf` attachment
  - settings option: fetch missing covers through ISBN
  - settings option: fetch missing covers through metadata
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

## Acknowledgements

- Based on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) by [@windingwind](https://github.com/windingwind).
- Inspired by [this](https://forums.zotero.org/discussion/121736/feature-request-cover-flow-or-book-jacket-image-display-view) discussion on the Zotero forum.
- Implementation also inspired by [zotero-lib-view](https://github.com/reiherj/zotero-lib-view).
- ISBN and metadata-based cover images for books are provided by [Open Library](https://openlibrary.org/) through its [Covers API](https://openlibrary.org/dev/docs/api/covers).

## Disclaimer

This project is licensed under the AGPL-3.0 and is provided as-is, without any warranties or guarantees.
