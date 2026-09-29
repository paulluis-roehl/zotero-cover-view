# Grid drag manual acceptance

The integration test covers Zotero's installed item payload helper and collection
drop handler. Real OS drag sessions cannot be exercised by synthetic DOM events.

## Verified manually on Linux

- A standalone PDF tile drags into the file manager and an email program; the
  original PDF remains available in Zotero after the file-manager drag.
  Zotero supplies the Linux file-URL drag flavor; the email check confirms an
  additional compatible external file target, not the flavor in isolation.
- A parent book tile drags into LibreOffice and inserts a reference. Child
  attachments do not have grid tiles, so dragging a child file from its parent
  is not supported (intended for now). The integration test confirms a parent
  payload does not silently include its child's file.
- Selected and unselected tiles drag into another collection; move/copy modifier
  keys work.
- Dropping an item back into its source collection is rejected.
- A same-library drop onto the library root is rejected, as expected for items
  already in that library. A cross-library drop onto a library root is a
  different case.
- A book tile drags into LibreOffice and inserts a reference (Quick Copy). The
  formatting matches a list-view drag, including RTF.

## Still to verify

- Windows: drag a standalone attachment into the file manager and confirm a
  file stored in Zotero is copied rather than moved out of storage.
- macOS: verify standalone attachment file-manager export via file promises.
- Collection targets not covered by the Linux report: a read-only group
  collection (only if you have access to a group library without edit
  permissions), and a collection in another library (if available). These are
  target *types*, not every individual collection. Cross-library drop onto a
  library root is also unverified.
