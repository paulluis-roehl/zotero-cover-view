import { findEPUBCoverURI } from "./epubCover";
import { findPDFCoverURI } from "./pdfCover";

export class CoverProvider {
  private static cache = new Map<number, Promise<string | null>>();

  static cacheCover(item: Zotero.Item): void {
    if (!this.cache.has(item.id)) {
      const cover = this.findCover(item).catch((error) => {
        ztoolkit.log("Failed to resolve cover", item.id, error);
        return null;
      });
      this.cache.set(item.id, cover);
    }
  }

  static getCover(itemID: number): Promise<string | null> {
    return this.cache.get(itemID) ?? Promise.resolve(null);
  }

  static async findCover(
    item: Zotero.Item,
    findEPUBCover: typeof findEPUBCoverURI = findEPUBCoverURI,
    findPDFCover: typeof findPDFCoverURI = findPDFCoverURI,
  ): Promise<string | null> {
    for (const attachment of this.findEPUBAttachments(item)) {
      try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) continue;

        const cover = await findEPUBCover(filePath);
        if (cover) return cover;
      } catch (error) {
        ztoolkit.log("Failed to find EPUB cover", attachment.id, error);
      }
    }

    for (const attachment of this.findPDFAttachments(item)) {
      try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) continue;

        const cover = await findPDFCover(filePath);
        if (cover) return cover;
      } catch (error) {
        ztoolkit.log("Failed to find PDF cover", attachment.id, error);
      }
    }
    return null;
  }

  static async createThumbnail(_source: string): Promise<string | null> {
    return null;
  }

  static clearCache(): void {
    this.cache.clear();
  }

  private static findEPUBAttachments(item: Zotero.Item): Zotero.Item[] {
    if (item.isFileAttachment()) {
      return this.isEPUBAttachment(item) ? [item] : [];
    }
    if (!item.isRegularItem()) {
      return [];
    }
    return Zotero.Items.get(item.getAttachments()).filter((attachment) =>
      this.isEPUBAttachment(attachment),
    );
  }

  private static isEPUBAttachment(item: Zotero.Item): boolean {
    return (
      item.isFileAttachment() &&
      (item.attachmentContentType === "application/epub+zip" ||
        item.attachmentReaderType === "epub")
    );
  }

  private static findPDFAttachments(item: Zotero.Item): Zotero.Item[] {
    if (item.isFileAttachment()) {
      return this.isPDFAttachment(item) ? [item] : [];
    }
    if (!item.isRegularItem()) {
      return [];
    }
    return Zotero.Items.get(item.getAttachments()).filter((attachment) =>
      this.isPDFAttachment(attachment),
    );
  }

  private static isPDFAttachment(item: Zotero.Item): boolean {
    return (
      item.isFileAttachment() &&
      (item.attachmentContentType === "application/pdf" ||
        item.attachmentReaderType === "pdf")
    );
  }
}
