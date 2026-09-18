import { assert } from "chai";
import { findImgCoverURI, isImgAttachment } from "../src/modules/imgCover";

describe("Image cover discovery", function () {
  function attachment(
    contentType: string,
    filePath: string | false = "cover.jpg",
  ): Zotero.Item {
    return {
      attachmentContentType: contentType,
      isFileAttachment: () => true,
      getFilePathAsync: async () => filePath,
    } as unknown as Zotero.Item;
  }

  for (const contentType of [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/tiff",
  ]) {
    it(`supports ${contentType} attachments`, function () {
      assert.isTrue(isImgAttachment(attachment(contentType)));
    });
  }

  it("returns a file URI for an image attachment", async function () {
    const filePath = "/tmp/cover image.png";

    assert.equal(
      await findImgCoverURI(filePath),
      Zotero.File.pathToFileURI(filePath),
    );
  });

  it("rejects unsupported and non-file attachments", function () {
    assert.isFalse(isImgAttachment(attachment("image/svg+xml", "cover.svg")));
    assert.isFalse(
      isImgAttachment({
        attachmentContentType: "image/png",
        isFileAttachment: () => false,
      } as unknown as Zotero.Item),
    );
  });
});
