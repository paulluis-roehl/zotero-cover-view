import { getPref } from "../utils/prefs";
import { findEPUBCoverURI, isEPUBAttachment } from "./epubCover";
import { findImgCoverURI, isImgAttachment } from "./imgCover";
import { extractISBNs, findISBNCoverURI } from "./isbnCover";
import { createPlaceholderCoverURI } from "./placeholderCover";
import {
  cachePDFCover,
  createPDFCacheSignature,
  deleteCachedPDFCover,
  findPDFCoverURI,
  getCachedPDFCover,
  isPDFAttachment,
} from "./pdfCover";

export class CoverProvider {
  private static cache = new Map<
    number,
    { generation: number; promise: Promise<string | null> }
  >();
  private static generations = new Map<number, number>();
  private static attachmentParents = new Map<number, number>();
  private static notifierID: string | undefined;

  static cacheCover(item: Zotero.Item): void {
    if (!this.cache.has(item.id)) {
      const generation = this.currentGeneration(item.id);
      const cover = this.findCover(
        item,
        undefined,
        undefined,
        undefined,
        undefined,
        generation,
      )
        .catch((error) => {
          ztoolkit.log("Failed to resolve cover", item.id, error);
          return null;
        })
        .then((value) =>
          this.currentGeneration(item.id) === generation ? value : null,
        );
      this.cache.set(item.id, { generation, promise: cover });
    }
  }

  static getCover(itemID: number): Promise<string | null> {
    return this.cache.get(itemID)?.promise ?? Promise.resolve(null);
  }

  static shouldFetchISBNCover(): boolean {
    return getPref("fetchISBNCover");
  }

  static async findCover(
    item: Zotero.Item,
    findEPUBCover: typeof findEPUBCoverURI = findEPUBCoverURI,
    findPDFCover: typeof findPDFCoverURI = findPDFCoverURI,
    findImgCover: typeof findImgCoverURI = findImgCoverURI,
    findISBNCover: typeof findISBNCoverURI = findISBNCoverURI,
    generation = this.currentGeneration(item.id),
  ): Promise<string | null> {
    for (const attachment of this.findAttachments(item, isImgAttachment)) {
      this.rememberParent(attachment, item);
      try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) continue;

        const cover = await findImgCover(filePath);
        if (cover) return cover;
      } catch (error) {
        ztoolkit.log("Failed to find image cover", attachment.id, error);
      }
    }

    for (const attachment of this.findAttachments(item, isEPUBAttachment)) {
      this.rememberParent(attachment, item);
      try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) continue;

        const cover = await findEPUBCover(filePath);
        if (cover) return cover;
      } catch (error) {
        ztoolkit.log("Failed to find EPUB cover", attachment.id, error);
      }
    }

    for (const attachment of this.findAttachments(item, isPDFAttachment)) {
      this.rememberParent(attachment, item);
      try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) continue;

        const signature = createPDFCacheSignature(attachment, filePath);
        const cached =
          findPDFCover === findPDFCoverURI
            ? await getCachedPDFCover(item.id, signature)
            : null;
        const cover = cached ?? (await findPDFCover(filePath));
        if (
          cover &&
          findPDFCover === findPDFCoverURI &&
          !cached &&
          this.currentGeneration(item.id) === generation
        ) {
          await cachePDFCover(item.id, signature, cover);
        }
        if (cover) return cover;
      } catch (error) {
        ztoolkit.log("Failed to find PDF cover", attachment.id, error);
      }
    }

    if (item.isRegularItem?.() && getPref("fetchISBNCover")) {
      for (const isbn of extractISBNs(item.getField("ISBN"))) {
        try {
          const cover = await findISBNCover(isbn);
          if (cover) return cover;
        } catch (error) {
          ztoolkit.log("Failed to find ISBN cover", isbn, error);
        }
      }
    }

    return createPlaceholderCoverURI(item);
  }

  static clearCache(): void {
    this.cache.clear();
    this.generations.clear();
    this.attachmentParents.clear();
  }

  static registerNotifier(): void {
    if (this.notifierID) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (_event, _type, ids, extraData) => {
          for (const rawID of ids) {
            const id = Number(rawID);
            const attachment = Zotero.Items.get(id);
            const parentIDs = new Set<number>();
            const knownParent = this.attachmentParents.get(id);
            if (knownParent) parentIDs.add(knownParent);
            if (attachment && attachment.isFileAttachment()) {
              if (this.isSupportedAttachment(attachment)) {
                if (attachment.parentItemID)
                  parentIDs.add(attachment.parentItemID);
                this.rememberParent(attachment, attachment);
              }
            }
            const data =
              extraData?.[rawID] ?? extraData?.[String(id)] ?? extraData;
            for (const key of [
              "oldParentItemID",
              "previousParentItemID",
              "oldParentID",
              "oldParent",
            ]) {
              if (data?.[key]) parentIDs.add(Number(data[key]));
            }
            for (const parentID of parentIDs) this.invalidate(parentID);
          }
        },
      },
      ["item"],
      "cover-view-covers",
    );
  }

  static unregisterNotifier(): void {
    if (!this.notifierID) return;
    Zotero.Notifier.unregisterObserver(this.notifierID);
    this.notifierID = undefined;
  }

  static invalidate(itemID: number): void {
    this.generations.set(itemID, (this.generations.get(itemID) ?? 0) + 1);
    this.cache.delete(itemID);
    void deleteCachedPDFCover(itemID);
  }

  private static currentGeneration(itemID: number): number {
    return this.generations.get(itemID) ?? 0;
  }

  private static rememberParent(
    attachment: Zotero.Item,
    item: Zotero.Item,
  ): void {
    if (attachment.id && item.isRegularItem?.()) {
      this.attachmentParents.set(attachment.id, item.id);
    }
  }

  private static isSupportedAttachment(item: Zotero.Item): boolean {
    return (
      isImgAttachment(item) || isEPUBAttachment(item) || isPDFAttachment(item)
    );
  }

  private static findAttachments(
    item: Zotero.Item,
    isSupported: (attachment: Zotero.Item) => boolean,
  ): Zotero.Item[] {
    if (item.isFileAttachment()) {
      return isSupported(item) ? [item] : [];
    }
    if (!item.isRegularItem()) {
      return [];
    }
    return Zotero.Items.get(item.getAttachments()).filter(isSupported);
  }
}
