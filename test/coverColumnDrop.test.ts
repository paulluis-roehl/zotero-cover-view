import { assert } from "chai";
import { onTeardown, openGrid, setPref, until } from "./helpers/gridFixture";
import { imageBytes, scratchFile } from "./helpers/testEnvironment";

describe("cover column drops", function () {
  this.timeout(30000);

  it("keeps the dropped image's attachment selected while its cover refreshes", async function () {
    setPref("fetchISBNCover", false);
    setPref("fetchMetadataCover", false);
    const grid = await openGrid({ view: "list", items: 1 });
    const [parent] = grid.items;
    grid.showColumn("Cover");
    await grid.select([parent]);
    const cover = () =>
      grid.itemRow(parent).querySelector<HTMLImageElement>('img[alt="Cover"]');
    const placeholder = (await until(cover, "the parent's cover")).src;

    const selections: number[][] = [];
    const itemsView = grid.pane.itemsView as _ZoteroTypes.ItemTree & {
      onSelect: {
        addListener(listener: () => void): void;
        removeListener(listener: () => void): void;
      };
    };
    const record = () => selections.push(grid.selectedItems());
    itemsView.onSelect.addListener(record);
    onTeardown(() => itemsView.onSelect.removeListener(record));

    const path = await scratchFile("cover.png", imageBytes(40, 60));
    const transfer = grid.fileTransfer([path]);
    assert.isTrue(grid.dragOver(grid.itemRow(parent), transfer).accepted);
    grid.drop(grid.itemRow(parent), transfer);
    grid.endDrag();

    const attachment = () =>
      Zotero.Items.get(parent.getAttachments()) as Zotero.Item[];
    const child = await until(
      () => {
        const [image] = attachment();
        return image?.key && cover()?.src.includes(image.key)
          ? image
          : undefined;
      },
      "the cover column to show the attached image",
      {
        observe: () => ({
          src: cover()?.src,
          attachments: attachment().map(({ id, key }) => ({ id, key })),
        }),
      },
    );
    const childID = child.id;
    await grid.settled();
    assert.deepEqual(grid.selectedItems(), [childID]);
    const selected = selections.findIndex((ids) => ids.includes(childID));
    assert.isAtLeast(selected, 0, "the attachment was selected");
    assert.isFalse(
      selections.slice(selected).some((ids) => ids.includes(parent.id)),
      `the parent was selected again: ${JSON.stringify(selections)}`,
    );

    await child.eraseTx();
    await until(
      () => cover()?.src === placeholder,
      "the placeholder to return once the attachment is gone",
      { observe: () => cover()?.src },
    );
  });
});
