const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

export class ImgCover {
  static isSupportedAttachment(item: Zotero.Item): boolean {
    return (
      item.isFileAttachment() &&
      IMAGE_CONTENT_TYPES.has(item.attachmentContentType)
    );
  }

  static async findCoverURI(attachment: Zotero.Item): Promise<string | null> {
    if (!ImgCover.isSupportedAttachment(attachment)) return null;

    const filePath = await attachment.getFilePathAsync();
    return filePath ? Zotero.File.pathToFileURI(filePath) : null;
  }
}
