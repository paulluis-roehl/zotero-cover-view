import { assert } from "chai";
import {
  createCollection,
  createItems,
  openGrid,
  selectedRow,
} from "./helpers/gridFixture";

describe("collection selection", function () {
  this.timeout(30000);

  it("shows the items of the selected collection", async function () {
    const grid = await openGrid({ items: 2 });
    const other = await createCollection();
    const items = await createItems(3, other);
    await grid.showRow(`C${other.id}`, items);
    assert.sameMembers(
      grid.mountedItems(),
      items.map(({ id }) => id),
    );
  });

  it("keeps the selected collection when a tile is clicked", async function () {
    const grid = await openGrid({ items: 2 });
    const [, second] = grid.items;
    grid.click(second);
    await grid.settled();
    assert.deepEqual(grid.selectedItems(), [second.id]);
    assert.equal(selectedRow(grid.pane), `C${grid.collection.id}`);
  });
});
