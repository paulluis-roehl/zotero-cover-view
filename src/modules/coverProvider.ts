import { findEPUBCoverURI } from "./epubCover";

export class CoverProvider {
  private static cache = new Map<number, string | null>();

  static async getCover(_itemID: number): Promise<string> {
    return `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;
  }

  static async findCover(
    item: Zotero.Item,
    findEPUBCover: typeof findEPUBCoverURI = findEPUBCoverURI,
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
    return null;
  }

  static async createThumbnail(_source: string): Promise<string | null> {
    return null;
  }

  static clearCache(): void {
    this.cache.clear();
  }

  private static findEPUBAttachments(item: Zotero.Item): Zotero.Item[] {
    if (this.isEPUBAttachment(item)) {
      return [item];
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
}
