# Grid drag manual acceptance

The integration test covers Zotero's installed item payload helper and collection
drop handler. Real OS drag sessions cannot be exercised by synthetic DOM events.

- On Windows, macOS, and Linux, drag a standalone PDF attachment from a grid tile
  into the file manager. Verify the file is copied and the original Zotero file
  remains available. On Windows, verify a file in Zotero storage is not moved out
  of storage. On macOS, verify promise-based file drags work; on Linux, verify
  file URL drags work.
- Drag a parent item with a child PDF: it should carry the item and Quick Copy,
  not silently export the child's file. Drag the standalone attachment separately
  to verify file export.
- Drag selected and unselected tiles onto another collection, the source
  collection, a library root, a read-only collection, and (where available) a
  collection in another library. Zotero's native drop feedback and add/move/copy
  rules should match a drag from the list view, including modifier keys.
- Drag a book tile into a text editor or citation-capable target: confirm Quick
  Copy text (and rich text if supported) matches a native list-view drag.

No OS/file-manager or cross-library drag session has been manually accepted yet.
