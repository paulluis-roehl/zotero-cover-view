import { assert } from "chai";
import { ImgCover } from "../src/modules/imgCover";

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
      assert.isTrue(ImgCover.isSupportedAttachment(attachment(contentType)));
    });
  }

  it("returns a file URI for an image attachment", async function () {
    const filePath = "/tmp/cover image.png";

    assert.equal(
      await ImgCover.findCoverURI(attachment("image/png", filePath)),
      Zotero.File.pathToFileURI(filePath),
    );
  });

  it("returns null for missing and unsupported files", async function () {
    assert.isNull(await ImgCover.findCoverURI(attachment("image/jpeg", false)));
    assert.isNull(
      await ImgCover.findCoverURI(attachment("image/svg+xml", "cover.svg")),
    );
  });
});
