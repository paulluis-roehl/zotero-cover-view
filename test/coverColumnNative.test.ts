import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
import { coverImageFixture } from "./helpers/coverFixture";

async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(condition(), message);
}

describe("native cover column selection", function () {
  this.timeout(20000);

  it("does not return focus to the parent after a dropped image selects its attachment", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const view = pane.itemsView;
    const collections = pane.collectionsView;
    if (!view || !collections)
      throw new Error("Native library tree is unavailable");
    const keys = [
      "enableGridView",
      "fetchISBNCover",
      "fetchMetadataCover",
    ] as const;
    const saved = keys.map(getPref);
    const collection = new Zotero.Collection();
    const parent = new Zotero.Item("book");
    const directory = `/tmp/opencode/column-native-${Zotero.Utilities.randomString()}`;
    const path = PathUtils.join(directory, "cover.png");
    let sampling = true;
    let restoreColumn: (() => void) | undefined;
    const selections: number[][] = [];
    const sample = () => {
      selections.push(pane.getSelectedItems(true));
      if (sampling) win.requestAnimationFrame(sample);
    };
    try {
      keys.forEach((key) => setPref(key, false));
      await IOUtils.makeDirectory(directory, { createAncestors: true });
      await IOUtils.write(path, coverImageFixture(40, 60));
      collection.name = "Native cover refresh selection";
      await collection.saveTx();
      parent.setField("title", "Image drop parent");
      parent.addToCollection(collection.id);
      await parent.saveTx();
      await collections.selectByID(`C${collection.id}`);
      await pane.selectItems([parent.id]);
      const coverOption = () => {
        const picker = win.document.createXULElement("menupopup");
        view.buildColumnPickerMenu(picker);
        return picker.querySelector('[label="Cover"]')!;
      };
      if (coverOption().getAttribute("checked") !== "true") {
        coverOption().dispatchEvent(new win.Event("command"));
        restoreColumn = () =>
          coverOption().dispatchEvent(new win.Event("command"));
      }
      const row = view.getRowIndexByID(String(parent.id));
      assert.isNumber(row);
      const image = () =>
        win.document.querySelector<HTMLImageElement>(
          `#${view.tree.props.id}-row-${view.getRowIndexByID(String(parent.id))} img[alt="Cover"]`,
        );
      await waitFor(
        () => !!image(),
        `initial cover; tree id ${view.tree.props.id}`,
      );
      const placeholder = image()!.src;
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      const transfer = {
        types: ["application/x-moz-file", "Files"],
        mozItemCount: 1,
        mozGetDataAt: (type: string) =>
          type === "application/x-moz-file" ? file : null,
        dropEffect: "copy",
        getData: () => "",
      } as unknown as DataTransfer;
      const event = new win.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      const dragDrop = (
        Zotero as typeof Zotero & {
          DragDrop: { currentOrientation: number; currentDropEffect: string };
        }
      ).DragDrop;
      dragDrop.currentOrientation = 0;
      dragDrop.currentDropEffect = "copy";
      sample();
      await view.onDrop(event, row);
      await Zotero.Promise.delay(1000);
      sampling = false;
      const childID = parent.getAttachments()[0];
      assert.isNumber(childID);
      const child = Zotero.Items.get(childID);
      if (!child) throw new Error("Dropped attachment is unavailable");
      await waitFor(
        () => !!image()?.src.includes(child.key),
        "attachment cover",
      );
      assert.notEqual(image()!.src, placeholder);
      assert.deepEqual(pane.getSelectedItems(true), [childID]);
      const firstChild = selections.findIndex((ids) => ids.includes(childID));
      assert.isAtLeast(firstChild, 0, "attachment selection was sampled");
      assert.isFalse(
        selections.slice(firstChild).some((ids) => ids.includes(parent.id)),
        `focus returned to parent: ${JSON.stringify(selections.filter((ids, i) => i === 0 || String(ids) !== String(selections[i - 1])))}`,
      );
      await child.eraseTx();
      await waitFor(
        () => image()?.src === placeholder,
        "placeholder after removal",
      );
    } finally {
      sampling = false;
      restoreColumn?.();
      await collections.selectLibrary(Zotero.Libraries.userLibraryID);
      if (parent.id) await parent.eraseTx();
      if (collection.id) await collection.eraseTx();
      keys.forEach((key, index) => setPref(key, saved[index]));
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  });
});
