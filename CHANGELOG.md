# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- covers are displayed in the Item Pane

### Changed

- attachments are now ranked by Zotero's native ranking instead of by file type

## [0.5.3] - 2026-10-08

### Fixed

- Preserve visible item in grid view upon grid resizing
- File drops now use native handler

## 0.5.0

- Drag-and-drop files in grid view
- Enhance grid view display options
- Enhance settings

## 0.4.1

- Cache metadata cover search results across Zotero restarts, so unchanged books do not repeat Open Library searches.
- Render complete PDF covers for scanned pages whose CCITT-compressed images were previously omitted.

## 0.4.0

- Optional cover search based on metadata
- Add more keyboard shortcuts
- Add context menu to grid view
- Option to change grid size (and `ctrl+scroll` shortcut)

## 0.3.3

- Keep rapid grid selection changes in order, so clicks and keyboard actions apply to the intended items.
- Wait for Zotero to confirm the current selection before running item commands, and recover cleanly if a selection change fails.

## 0.3.2

- Navigate the cover grid with arrow keys, Home, and End; movement follows the visual layout as the grid resizes.
- Use modifier keys to select multiple items, and run familiar item commands directly from the grid.
- Keep the selected collection and grid focus stable when clicking items, switching views, reordering items, or deleting an item.
