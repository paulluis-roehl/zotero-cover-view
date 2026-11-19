/**
 * Cover lookup outside the live grid view, through the test file's own cover
 * provider. Items are kept out of the live plugin's views, so that only the
 * test looks up their covers.
 */

import { assert } from "chai";
import { BasicTool } from "zotero-plugin-toolkit";
import { CoverProvider, CoverResult } from "../../src/modules/coverProvider";
import { deleteCachedPDFCover } from "../../src/modules/covers/pdfCover";
import {
  CoverKind,
  onTeardown,
  patch,
  showEmptyCollection,
  track,
} from "./gridFixture";
import { imageSize } from "./testEnvironment";

/**
 * Prepare the current test to look up covers: provide the toolkit the cover
 * provider logs to, keep items out of the live plugin's views, and listen to
 * Zotero notifications. The provider forgets everything when the test ends.
 */
export async function useCoverProvider(): Promise<void> {
  patch(
    globalThis as unknown as { ztoolkit: unknown },
    "ztoolkit",
    new BasicTool(),
  );
  await showEmptyCollection();
  onTeardown(() => CoverProvider.clearCache());
  CoverProvider.registerNotifier();
  onTeardown(() => CoverProvider.unregisterNotifier());
}

// Covers are told apart by the width-to-height ratio of their images.
export const TALL = 0.5;
export const WIDE = 2;
export const SQUARE = 1;

export interface AttachOptions {
  /** The parent item; omit for a standalone attachment. */
  parent?: Zotero.Item;
  /** Zotero ranks attachments added earlier first, other things equal. */
  dateAdded?: string;
  /** Zotero ranks attachments with the parent's URL first. */
  url?: string;
}

/** Link `file` as an attachment that is erased when the current test ends. */
export async function attach(
  file: string,
  contentType: string,
  { parent, dateAdded, url }: AttachOptions = {},
): Promise<Zotero.Item> {
  const [attachment] = track(
    await Zotero.Attachments.linkFromFile({
      file,
      contentType,
      parentItemID: parent?.id,
    }),
  );
  if (contentType === "application/pdf") {
    const owner = (parent ?? attachment).id;
    onTeardown(() => deleteCachedPDFCover(owner));
  }
  if (dateAdded || url) {
    if (dateAdded) attachment.setField("dateAdded", dateAdded);
    if (url) attachment.setField("url", url);
    await attachment.saveTx();
  }
  return attachment;
}

/** Look up the current cover of `item` afresh, as on first display. */
export async function findCover(item: Zotero.Item): Promise<CoverResult> {
  const cover = await CoverProvider.findCoverResult(item);
  if (!cover) throw new Error(`No cover for item ${item.id}`);
  return cover;
}

/**
 * Assert the kind of `cover` and, to tell covers apart, the width-to-height
 * ratio of its image.
 */
export async function assertCover(
  cover: CoverResult | null | undefined,
  kind: CoverKind,
  ratio?: number,
  message = "",
): Promise<void> {
  assert.equal(cover?.source, kind, message);
  if (ratio === undefined) return;
  const { width, height } = await imageSize(cover!.uri);
  assert.closeTo(width / height, ratio, 0.02, message);
}
