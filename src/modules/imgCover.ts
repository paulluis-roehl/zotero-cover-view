const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

export function isImgAttachment(item: Zotero.Item): boolean {
  return (
    item.isFileAttachment() &&
    IMAGE_CONTENT_TYPES.has(item.attachmentContentType)
  );
}

export function findImgCoverURI(filePath: string): Promise<string> {
  return Promise.resolve(Zotero.File.pathToFileURI(filePath));
}
