import { assert } from "chai";
import { CoverProvider } from "../src/modules/coverProvider";
import { GridRenderer } from "../src/modules/gridRenderer";
import { getPref, setPref } from "../src/utils/prefs";

describe("grid view", function () {
  before(function () {
    Object.defineProperty(globalThis, "addon", {
      value: Zotero.CoverView,
      configurable: true,
    });
  });

  after(function () {
    Reflect.deleteProperty(globalThis, "addon");
  });

  it("follows selection changes, retains empty-selection focus, and restores identity after reorder", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const items = Array.from({ length: 3 }, () => new Zotero.Item("book"));
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const entries = () =>
      Array.from(grid.querySelectorAll<HTMLElement>(".grid-view-item"));
    const focused = () => grid.getAttribute("aria-activedescendant");
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition());
    };
    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Continuity ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(() =>
        items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      const [first, second, third] = entries();
      first.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(first.dataset.itemId),
      );

      await pane.selectItems([Number(second.dataset.itemId)], true);
      await waitFor(() => focused() === second.id);
      await pane.selectItems(
        [Number(first.dataset.itemId), Number(third.dataset.itemId)],
        true,
      );
      await waitFor(() => focused() === third.id);
      pane.itemsView!.selection.clearSelection();
      await waitFor(() => !grid.querySelector(".grid-view-item.selected"));
      assert.equal(focused(), third.id, "Empty selection retains valid focus");
      third.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(third.dataset.itemId),
      );
      pane.itemsView!.selection.clearSelection();
      await waitFor(() => !grid.querySelector(".grid-view-item.selected"));

      // A title change moves the focused item in Zotero's displayed sort order.
      const reordered = items.find(
        (item) => item.id === Number(third.dataset.itemId),
      )!;
      reordered.setField("title", `AAA Continuity ${Date.now()}`);
      await reordered.saveTx();
      await waitFor(() => entries()[0].dataset.itemId === String(reordered.id));
      assert.equal(focused(), third.id);
      grid.style.gridTemplateColumns = "150px";
      assert.equal(focused(), third.id);
      const successor = entries()[1];
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(() =>
        pane.getSelectedItems(true).includes(Number(successor.dataset.itemId)),
      );
      assert.deepEqual(
        pane.getSelectedItems(true),
        [reordered.id, Number(successor.dataset.itemId)],
        "Anchor follows the reordered item",
      );
    } finally {
      grid.style.gridTemplateColumns = "";
      if (grid.hidden !== originallyHidden) toggle();
      for (const item of items) if (item.id) await item.eraseTx();
    }
  });

  it("falls back to selected and first tiles when returning with invalid grid focus", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition());
    };
    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Invalid focus ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(() =>
        items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      const first = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[0].id}"]`,
      )!;
      const second = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[1].id}"]`,
      )!;
      first.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => pane.getSelectedItems(true)[0] === items[0].id);
      toggle();
      await items[0].eraseTx();
      await pane.selectItems([items[1].id], true);
      toggle();
      assert.equal(grid.getAttribute("aria-activedescendant"), second.id);

      toggle();
      pane.itemsView!.selection.clearSelection();
      await items[1].eraseTx();
      const remaining = new Zotero.Item("book");
      remaining.setField("title", `Only remaining ${Date.now()}`);
      await remaining.saveTx();
      items.push(remaining);
      toggle();
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        `cover-view-grid-item-${remaining.id}`,
      );
    } finally {
      if (grid.hidden !== originallyHidden) toggle();
      for (const item of items)
        if (item.id && Zotero.Items.get(item.id)) await item.eraseTx();
    }
  });

  it("retains grid focus across reflow and switches focus between item views", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const tree = win.document.getElementById("zotero-items-tree")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originalStyle = grid.style.cssText;
    const originallyHidden = grid.hidden;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const waitFor = async (
      condition: () => boolean,
      message = "Condition not reached",
    ) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), message);
    };

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Focus continuity ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(() =>
        items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      const entry = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[0].id}"]`,
      )!;
      entry.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(() => pane.getSelectedItems(true)[0] === items[0].id);
      grid.style.gridTemplateColumns = "150px";
      assert.equal(grid.getAttribute("aria-activedescendant"), entry.id);

      toggle();
      await waitFor(
        () => tree.contains(win.document.activeElement),
        "Grid-to-tree focus transfer",
      );
      assert.deepEqual(pane.getSelectedItems(true), [items[0].id]);
      await pane.selectItems([items[1].id], true);
      tree.querySelector<HTMLElement>("[role=tree]")!.focus();
      toggle();
      assert.strictEqual(
        win.document.activeElement,
        grid,
        "Tree-to-grid transfer",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entry.id);
      assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);

      // The toolbar can receive focus before its command is dispatched.
      toggle();
      await waitFor(() => grid.hidden, "List mode before toolbar switch");
      await waitFor(
        () => tree.contains(win.document.activeElement),
        "Tree owns focus before toolbar switch",
      );
      tree.querySelector<HTMLElement>("[role=tree]")!.focus();
      button.focus();
      toggle();
      await waitFor(
        () => win.document.activeElement === grid,
        "Toolbar-to-grid transfer",
      );
    } finally {
      grid.style.cssText = originalStyle;
      if (grid.hidden !== originallyHidden) toggle();
      for (const item of items) if (item.id) await item.eraseTx();
    }
  });

  it("recovers focus and anchor after external removal", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const items = Array.from({ length: 3 }, () => new Zotero.Item("book"));
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition());
    };
    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Removal continuity ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(() =>
        items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const last = entries.at(-1)!;
      const predecessor = entries.at(-2)!;
      last.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(last.dataset.itemId),
      );
      await items
        .find((item) => item.id === Number(last.dataset.itemId))!
        .eraseTx();
      await waitFor(
        () => grid.getAttribute("aria-activedescendant") === predecessor.id,
      );
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      );
      await waitFor(() => pane.getSelectedItems(true).length > 0);
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        entries.at(-3)!.id,
      );
    } finally {
      if (grid.hidden !== originallyHidden) toggle();
      for (const item of items)
        if (item.id && Zotero.Items.get(item.id)) await item.eraseTx();
    }
  });

  it("uses the same predecessor fallback after a grid Delete command", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const originallyHidden = grid.hidden;
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const items = Array.from({ length: 3 }, () => new Zotero.Item("book"));
    const actions = pane as unknown as {
      deleteSelectedItems: (force?: boolean) => Promise<void>;
    };
    const originalDelete = actions.deleteSelectedItems;
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.isTrue(condition());
    };
    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid delete focus ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(() =>
        items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ),
      );
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      const [first, middle, last] = entries;
      middle.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(middle.dataset.itemId),
      );
      actions.deleteSelectedItems = async () => {
        await items
          .find((item) => item.id === Number(middle.dataset.itemId))!
          .eraseTx();
      };
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(
        () => grid.getAttribute("aria-activedescendant") === first.id,
      );
      await Zotero.Promise.delay(250);
      assert.equal(
        grid.getAttribute("aria-activedescendant"),
        first.id,
        "Deletion keeps predecessor focus after selection settles",
      );
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(() => pane.getSelectedItems(true).length === 2);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(first.dataset.itemId),
        Number(last.dataset.itemId),
      ]);
    } finally {
      actions.deleteSelectedItems = originalDelete;
      if (grid.hidden !== originallyHidden) toggle();
      for (const item of items)
        if (item.id && Zotero.Items.get(item.id)) await item.eraseTx();
    }
  });

  it("restores visible native rows after scrolling the hidden list", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items: Zotero.Item[] = [];
    const toggle = () => button.dispatchEvent(new win.Event("command"));

    try {
      for (let index = 0; index < 8; index++) {
        const item = new Zotero.Item("book");
        item.setField("title", `Hidden list layout test ${index}`);
        await item.saveTx();
        items.push(item);
      }
      if (grid.hidden) toggle();
      await pane.selectItems([items[0].id], true);
      if (!pane.itemsView) throw new Error("Native item view is unavailable");
      const list = pane.itemsView._treebox;

      // Native selection can scroll this list while its ancestor is display:none.
      // Reproduce the resulting mismatch between its cache and the DOM offset.
      list.scrollTo(4 * list.itemHeight);
      assert.isAbove(list.scrollOffset, list.targetElement.scrollTop);

      toggle();
      assert.isAbove(list.getWindowHeight(), 0);
      assert.equal(list.scrollOffset, list.targetElement.scrollTop);
      const first = list.getFirstVisibleRow();
      const last = Math.min(
        list.getLastVisibleRow(),
        pane.itemsView.rowCount - 1,
      );
      for (let index = first; index <= last; index++) {
        const row = list.getElementByIndex(index);
        assert.exists(row, `Visible native row ${index} must be rendered`);
        assert.isNotEmpty(row.textContent.trim());
      }
      assert.deepEqual(pane.getSelectedItems(true), [items[0].id]);
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) await item.eraseTx();
    }
  });

  it("displays native selection when switching from the tree to the grid", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const selectedIDs = () =>
      Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item.selected"),
      ).map((entry) => Number(entry.dataset.itemId));

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid selection test ${index}`);
        await item.saveTx();
      }
      if (!grid.hidden) toggle();
      await pane.selectItems([items[0].id], true);
      toggle();
      assert.deepEqual(selectedIDs(), [items[0].id]);

      const selected = grid.querySelector<HTMLElement>(
        ".grid-view-item.selected",
      )!;
      assert.notEqual(
        win.getComputedStyle(selected).backgroundColor,
        "rgba(0, 0, 0, 0)",
      );

      toggle();
      await pane.selectItems([items[1].id], true);
      toggle();
      assert.deepEqual(selectedIDs(), [items[1].id]);

      toggle();
      if (!pane.itemsView) throw new Error("Native item view is unavailable");
      pane.itemsView.selection.clearSelection();
      toggle();
      assert.isEmpty(selectedIDs());
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("updates selection without replacing tiles and ignores undisplayed IDs", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const item = new Zotero.Item("book");
    item.setField("title", "Selection presentation");
    // A display-only item avoids database notifications during this renderer test.
    const displayItem = {
      id: -1,
      getDisplayTitle: () => item.getDisplayTitle(),
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    try {
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      const entry = host.firstElementChild!;
      renderer.setSelection([-1, -2]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isTrue(entry.classList.contains("selected"));
      renderer.setSelection([]);
      assert.strictEqual(host.firstElementChild, entry);
      assert.isFalse(entry.classList.contains("selected"));
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      assert.strictEqual(host.firstElementChild, entry);
    } finally {
      renderer.destroy();
    }
  });

  it("exposes one focusable listbox with independently focused options", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const items = [-1, -2].map(
      (id) =>
        ({
          id,
          firstCreator: "",
          getDisplayTitle: () => `Accessible item ${id}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );

    try {
      renderer.setItems(items, { showAuthors: true });
      renderer.setSelection([-1]);
      renderer.setFocusedItem(-2);

      const [selected, focused] = Array.from(
        host.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.equal(host.tabIndex, 0);
      assert.equal(host.getAttribute("role"), "listbox");
      assert.equal(host.getAttribute("aria-multiselectable"), "true");
      assert.notExists(selected.getAttribute("tabindex"));
      assert.notExists(focused.getAttribute("tabindex"));
      assert.equal(selected.getAttribute("role"), "option");
      assert.equal(selected.getAttribute("aria-selected"), "true");
      assert.equal(focused.getAttribute("aria-selected"), "false");
      assert.equal(host.getAttribute("aria-activedescendant"), focused.id);
      assert.isTrue(focused.classList.contains("focused"));
      assert.isFalse(selected.classList.contains("focused"));
    } finally {
      renderer.destroy();
    }
  });

  it("passes native selection modifiers with grid navigation keys", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const commands: Array<{
      command: string;
      primary: boolean;
      shift: boolean;
    }> = [];
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command, modifiers) =>
        commands.push({ command: String(command), ...modifiers }),
    );
    const primaryKey = win.navigator.platform.startsWith("Mac")
      ? { metaKey: true }
      : { ctrlKey: true };

    try {
      const left = new win.KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      });
      const right = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      const up = new win.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      const down = new win.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      const home = new win.KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      });
      const end = new win.KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      });
      const shift = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const primary = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        ...primaryKey,
        bubbles: true,
        cancelable: true,
      });
      const primaryShift = new win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        ...primaryKey,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const unrelated = new win.KeyboardEvent("keydown", {
        key: "r",
        bubbles: true,
        cancelable: true,
      });

      host.dispatchEvent(left);
      host.dispatchEvent(right);
      host.dispatchEvent(up);
      host.dispatchEvent(down);
      host.dispatchEvent(home);
      host.dispatchEvent(end);
      host.dispatchEvent(shift);
      host.dispatchEvent(primary);
      host.dispatchEvent(primaryShift);
      host.dispatchEvent(unrelated);

      assert.deepEqual(
        commands.map(({ command }) => command),
        [
          "left",
          "right",
          "up",
          "down",
          "home",
          "end",
          "right",
          "right",
          "right",
        ],
      );
      assert.deepInclude(commands, {
        command: "right",
        primary: false,
        shift: true,
      });
      assert.deepInclude(commands, {
        command: "right",
        primary: true,
        shift: false,
      });
      assert.deepInclude(commands, {
        command: "right",
        primary: true,
        shift: true,
      });
      assert.isTrue(left.defaultPrevented);
      assert.isTrue(right.defaultPrevented);
      assert.isTrue(up.defaultPrevented);
      assert.isTrue(down.defaultPrevented);
      assert.isTrue(home.defaultPrevented);
      assert.isTrue(end.defaultPrevented);
      assert.isTrue(shift.defaultPrevented);
      assert.isTrue(primary.defaultPrevented);
      assert.isTrue(primaryShift.defaultPrevented);
      assert.isFalse(unrelated.defaultPrevented);
    } finally {
      renderer.destroy();
    }
  });

  it("interprets grid item commands without consuming unrelated shortcuts", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const commands: Array<{ command: string; forceDelete?: boolean }> = [];
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      undefined,
      undefined,
      (command, options) => commands.push({ command, ...options }),
    );
    const isMacOS = win.navigator.platform.startsWith("Mac");
    const primaryKey = isMacOS ? { metaKey: true } : { shiftKey: true };
    const press = (key: string, modifiers = {}) => {
      const event = new win.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      host.dispatchEvent(event);
      return event;
    };

    try {
      const enter = press("Enter");
      const space = press(" ");
      const deleteKey = press("Delete");
      const forceDelete = press("Delete", primaryKey);
      const backspace = press("Backspace");
      const unrelated = press("r");

      assert.deepEqual(commands, [
        { command: "activate" },
        { command: "toggle-selection" },
        { command: "delete", forceDelete: false },
        { command: "delete", forceDelete: true },
        ...(isMacOS ? [{ command: "delete", forceDelete: false }] : []),
      ]);
      assert.isTrue(enter.defaultPrevented);
      assert.isTrue(space.defaultPrevented);
      assert.isTrue(deleteKey.defaultPrevented);
      assert.isTrue(forceDelete.defaultPrevented);
      assert.equal(backspace.defaultPrevented, isMacOS);
      assert.isFalse(unrelated.defaultPrevented);
    } finally {
      renderer.destroy();
    }
  });

  it("bridges grid item commands to Zotero's selected-item actions", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = Array.from({ length: 20 }, () => new Zotero.Item("book"));
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const paneActions = pane as unknown as {
      viewItems: (items: Zotero.Item[]) => Promise<void>;
      deleteSelectedItems: (force?: boolean) => void;
    };
    const originalViewItems = paneActions.viewItems;
    const originalDeleteSelectedItems = paneActions.deleteSelectedItems;
    const activations: number[][] = [];
    const deletions: boolean[] = [];
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), message);
    };
    const press = (key: string, modifiers = {}) =>
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid command bridge ${Date.now()} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(
        () =>
          items.every((item) =>
            grid.querySelector(`[data-item-id="${item.id}"]`),
          ),
        "Command test items should be rendered",
      );
      paneActions.viewItems = async (selected) => {
        activations.push(selected.map((item) => item.id));
      };
      paneActions.deleteSelectedItems = (force = false) => {
        deletions.push(force);
      };

      await pane.selectItems([items[0].id, items[1].id], true);
      const focused = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[2].id}"]`,
      )!;
      focused.dispatchEvent(
        new win.MouseEvent("click", {
          bubbles: true,
          ...(win.navigator.platform.startsWith("Mac")
            ? { metaKey: true }
            : { ctrlKey: true }),
        }),
      );
      await waitFor(
        () => grid.getAttribute("aria-activedescendant") === focused.id,
        "Primary-click should focus an unselected tile",
      );

      press("Enter");
      await waitFor(
        () => activations.length === 1,
        "Enter should activate the authoritative selection",
      );
      assert.deepEqual(activations, [[items[0].id, items[1].id]]);

      focused.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      await waitFor(
        () => activations.length === 2,
        "Double-click should activate its clicked tile",
      );
      assert.deepEqual(activations[1], [items[2].id]);

      press(" ");
      await waitFor(
        () => pane.getSelectedItems(true).includes(items[2].id),
        "Space should toggle focused selection without moving focus",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), focused.id);

      await pane.selectItems([items[2].id], true);
      press(" ");
      await waitFor(
        () => pane.getSelectedItems(true).length === 0,
        "Space should allow the final selected item to be deselected",
      );
      press("Delete");
      await Zotero.Promise.delay(20);
      assert.isEmpty(deletions, "Delete should be a no-op without a selection");

      await pane.selectItems(
        items.map((item) => item.id),
        true,
      );
      press("Enter");
      await Zotero.Promise.delay(50);
      assert.lengthOf(
        activations,
        2,
        "Enter should not activate Zotero's 20-item selection",
      );

      await pane.selectItems([items[0].id], true);
      press("Delete");
      await waitFor(
        () => deletions.length === 1,
        "Delete should use Zotero's selected-item deletion action",
      );
      press(
        "Delete",
        win.navigator.platform.startsWith("Mac")
          ? { metaKey: true }
          : { shiftKey: true },
      );
      await waitFor(
        () => deletions.length === 2,
        "The platform force modifier should be bridged to Zotero",
      );
      assert.deepEqual(deletions, [false, true]);
    } finally {
      paneActions.viewItems = originalViewItems;
      paneActions.deleteSelectedItems = originalDeleteSelectedItems;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("renders tiles in finite chunks and appends the next chunk at the sentinel", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const OriginalIntersectionObserver = win.IntersectionObserver;
    let notify: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "400px") notify = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const items = Array.from(
      { length: 121 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Chunk item ${index}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );
    const renderer = new GridRenderer(host, () => {});

    try {
      renderer.setItems(items, {
        showAuthors: true,
        fetchISBNCover: false,
      });

      const firstChunk = host.querySelectorAll<HTMLElement>(".grid-view-item");
      assert.lengthOf(firstChunk, 120);
      assert.equal(firstChunk[0].dataset.renderIndex, "0");
      assert.equal(firstChunk[119].dataset.renderIndex, "119");
      assert.lengthOf(host.querySelectorAll(".grid-view-sentinel"), 1);
      const sentinel = host.querySelector(".grid-view-sentinel")!;
      notify?.(
        [
          {
            isIntersecting: true,
            target: sentinel,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 121);
      assert.equal(
        host.querySelectorAll<HTMLElement>(".grid-view-item")[120].dataset
          .renderIndex,
        "120",
      );
      assert.lengthOf(host.querySelectorAll(".grid-view-sentinel"), 0);
    } finally {
      renderer.destroy();
      win.IntersectionObserver = OriginalIntersectionObserver;
    }
  });

  it("starts cover loading only when a tile approaches the viewport", async function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const originalCacheCover = CoverProvider.cacheCover;
    const originalGetCover = CoverProvider.getCover;
    let notify: IntersectionObserverCallback | undefined;
    const cachedItemIDs: number[] = [];
    const requestedItemIDs: number[] = [];

    class FakeIntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        if (options?.rootMargin === "200px") notify = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    CoverProvider.cacheCover = (item) => cachedItemIDs.push(item.id);
    CoverProvider.getCover = (itemID) => {
      requestedItemIDs.push(itemID);
      return Promise.resolve(null);
    };

    const displayItem = {
      id: -1,
      firstCreator: "",
      getDisplayTitle: () => "Lazy cover",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;
    const renderer = new GridRenderer(host, () => {});

    try {
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      assert.isEmpty(cachedItemIDs);
      assert.isEmpty(requestedItemIDs);

      const tile = host.querySelector(".grid-view-item")!;
      notify?.(
        [
          {
            isIntersecting: true,
            target: tile,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      await Promise.resolve();

      assert.deepEqual(cachedItemIDs, [displayItem.id]);
      assert.deepEqual(requestedItemIDs, [displayItem.id]);
    } finally {
      renderer.destroy();
      CoverProvider.cacheCover = originalCacheCover;
      CoverProvider.getCover = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("passes a tile click to the renderer selection callback", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    let selectedID: number | undefined;
    const renderer = new GridRenderer(host, (itemID) => {
      selectedID = itemID;
    });
    const displayItem = {
      id: -1,
      getDisplayTitle: () => "Clicked item",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      host
        .querySelector(".grid-view-cover")!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      assert.equal(selectedID, displayItem.id);
    } finally {
      renderer.destroy();
    }
  });

  it("passes a tile double-click to the renderer activation callback", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    let activatedID: number | undefined;
    const renderer = new GridRenderer(
      host,
      () => {},
      (itemID) => {
        activatedID = itemID;
      },
    );
    const displayItem = {
      id: -1,
      getDisplayTitle: () => "Activated item",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      host
        .querySelector(".grid-view-cover")!
        .dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      assert.equal(activatedID, displayItem.id);
    } finally {
      renderer.destroy();
    }
  });

  it("renders the title and authors on separate caption lines", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const renderer = new GridRenderer(host, () => {});
    const displayItem = {
      id: -1,
      firstCreator: "Ada Lovelace and Charles Babbage",
      getDisplayTitle: () => "Analytical Engine Notes",
      isFileAttachment: () => false,
      isRegularItem: () => false,
    } as unknown as Zotero.Item;

    try {
      renderer.setItems([displayItem], {
        showAuthors: true,
        fetchISBNCover: false,
      });
      assert.equal(
        host.querySelector(".grid-view-title")?.textContent,
        "Analytical Engine Notes",
      );
      assert.equal(
        host.querySelector(".grid-view-authors")?.textContent,
        "Ada Lovelace and Charles Babbage",
      );
      assert.equal(
        host.querySelector(".grid-view-cover img")?.alt,
        "Cover for Analytical Engine Notes",
      );

      renderer.setItems([displayItem], {
        showAuthors: false,
        fetchISBNCover: false,
      });
      assert.notExists(host.querySelector(".grid-view-authors"));
    } finally {
      renderer.destroy();
    }
  });

  it("refreshes automatically on preference changes and applies changes made in list mode", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const originalShowAuthors = getPref("showAuthors");
    const originallyHidden = grid.hidden;
    const item = new Zotero.Item("book");
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const authorLine = () =>
      grid.querySelector(`[data-item-id="${item.id}"] .grid-view-authors`);
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), "Grid should reflect the changed preference");
    };

    try {
      item.setField("title", "Preference refresh test");
      item.setCreators([
        { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
      ]);
      await item.saveTx();
      setPref("showAuthors", true);
      if (grid.hidden) toggle();
      await pane.selectItems([item.id], true);
      await waitFor(() => !!authorLine());

      setPref("showAuthors", false);
      await waitFor(() => !authorLine());
      assert.exists(grid.querySelector(`[data-item-id="${item.id}"]`));
      setPref("showAuthors", true);
      await waitFor(() => !!authorLine());

      toggle();
      const previousTile = grid.querySelector(`[data-item-id="${item.id}"]`);
      setPref("showAuthors", false);
      await Zotero.Promise.delay(100);
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${item.id}"]`),
        previousTile,
      );
      toggle();
      assert.notExists(authorLine());
      assert.exists(grid.querySelector(`[data-item-id="${item.id}"].selected`));
    } finally {
      setPref("showAuthors", originalShowAuthors);
      if (grid.hidden !== originallyHidden) toggle();
      if (item.id) await item.eraseTx();
    }
  });

  it("selects and focuses a grid tile when it is clicked", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Grid click selection test ${index}`);
        await item.saveTx();
      }
      if (!grid.hidden) toggle();
      toggle();

      const firstEntry = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[0].id}"]`,
      )!;
      const clickedEntry = grid.querySelector<HTMLElement>(
        `[data-item-id="${items[1].id}"]`,
      )!;
      assert.exists(firstEntry);
      assert.exists(clickedEntry);
      await pane.selectItems([items[0].id], true);
      grid.blur();
      grid.focus();
      grid.dispatchEvent(new win.FocusEvent("focus"));
      assert.equal(grid.getAttribute("aria-activedescendant"), firstEntry.id);

      clickedEntry.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true }),
      );
      await new Promise((resolve) => win.setTimeout(resolve, 100));

      assert.deepEqual(pane.getSelectedItems(true), [items[1].id]);
      assert.strictEqual(win.document.activeElement, grid);
      assert.equal(grid.getAttribute("aria-activedescendant"), clickedEntry.id);
      assert.isTrue(clickedEntry.classList.contains("focused"));
      assert.isTrue(clickedEntry.classList.contains("selected"));
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("applies native modifier selection while retaining focused unselected tiles", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = Array.from({ length: 4 }, () => new Zotero.Item("book"));
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const primaryKey = win.navigator.platform.startsWith("Mac")
      ? { metaKey: true }
      : { ctrlKey: true };
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), message);
    };
    const selectedIDs = () => pane.getSelectedItems(true);
    const equalIDs = (left: number[], right: number[]) =>
      left.length === right.length &&
      left.every((id, index) => id === right[index]);
    const sameIDs = (left: number[], right: number[]) =>
      left.length === right.length && right.every((id) => left.includes(id));
    const click = (entry: HTMLElement, modifiers = {}) =>
      entry.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, ...modifiers }),
      );
    const press = (key: string, modifiers = {}) =>
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );

    try {
      const titlePrefix = `Modifier selection ${Date.now()}`;
      for (const [index, item] of items.entries()) {
        item.setField("title", `${titlePrefix} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      await waitFor(
        () =>
          items.every((item) =>
            grid.querySelector(`[data-item-id="${item.id}"]`),
          ),
        "Modifier test items should be rendered",
      );
      const entries = items.map((item) =>
        grid.querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)!,
      );
      const range = (from: HTMLElement, to: HTMLElement) => {
        const all = Array.from(
          grid.querySelectorAll<HTMLElement>(".grid-view-item"),
        );
        const start = all.indexOf(from);
        const end = all.indexOf(to);
        return all
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((entry) => Number(entry.dataset.itemId));
      };

      click(entries[0]);
      await waitFor(
        () => selectedIDs().length === 1 && selectedIDs()[0] === items[0].id,
        "Plain click should replace selection",
      );
      click(entries[2], { shiftKey: true });
      const initialRange = range(entries[0], entries[2]);
      await waitFor(
        () => equalIDs(selectedIDs(), initialRange),
        "Shift-click should replace selection with the displayed range",
      );

      click(entries[1], primaryKey);
      await waitFor(
        () => !selectedIDs().includes(items[1].id),
        "Primary-click should toggle an item out of the selection",
      );
      click(entries[3], { ...primaryKey, shiftKey: true });
      const additiveRange = range(entries[0], entries[3]);
      await waitFor(
        () => sameIDs(selectedIDs(), additiveRange),
        "Primary+Shift-click should add the anchor range",
      );

      click(entries[1]);
      await waitFor(
        () => selectedIDs()[0] === items[1].id && selectedIDs().length === 1,
        "Plain click should reset the keyboard anchor",
      );
      press("ArrowRight", { shiftKey: true });
      const nextEntry = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      )[
        Array.from(grid.querySelectorAll(".grid-view-item")).indexOf(
          entries[1],
        ) + 1
      ];
      await waitFor(
        () => equalIDs(selectedIDs(), range(entries[1], nextEntry)),
        "Shift navigation should replace selection with the anchor range",
      );
      press("ArrowRight", primaryKey);
      await Zotero.Promise.delay(50);
      assert.deepEqual(selectedIDs(), range(entries[1], nextEntry));
      const focusedID = Number(
        grid.getAttribute("aria-activedescendant")!.match(/-(\d+)$/)![1],
      );
      assert.notInclude(selectedIDs(), focusedID);
      press("Home", { ...primaryKey, shiftKey: true });
      await waitFor(
        () => selectedIDs().includes(items[1].id),
        "Primary+Shift Home should add a range without clearing selection",
      );

      click(entries[1], primaryKey);
      await waitFor(
        () => !selectedIDs().includes(items[1].id),
        "Primary-click should toggle a selected item",
      );
      await pane.selectItems([items[0].id], true);
      await waitFor(
        () => selectedIDs().length === 1 && selectedIDs()[0] === items[0].id,
        "Native selection should contain the final toggle target",
      );
      click(entries[0], primaryKey);
      await waitFor(
        () => selectedIDs().length === 0,
        "Primary-click should allow an empty native selection",
      );
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[0].id);
    } finally {
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates displayed items horizontally through the focused grid host", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 2000;
      while (!condition() && Date.now() < deadline) {
        await Zotero.Promise.delay(20);
      }
      assert.isTrue(condition(), message);
    };

    try {
      await waitFor(
        () => !grid.querySelector(".grid-view-item"),
        "Previous grid items should be removed before navigation setup",
      );
      const titlePrefix = `Keyboard navigation ${Date.now()}`;
      for (const [index, item] of items.entries()) {
        item.setField("title", `${titlePrefix} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.gridTemplateColumns = "150px";
      await waitFor(() => {
        const renderedIDs = Array.from(
          grid.querySelectorAll<HTMLElement>(".grid-view-item"),
        ).map((entry) => Number(entry.dataset.itemId));
        return (
          renderedIDs.length === items.length &&
          items.every((item) => renderedIDs.includes(item.id))
        );
      }, "New items should be rendered in the grid");

      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.isAtLeast(entries.length, 2);
      const sourceIndex = entries.length - 2;
      const source = entries[sourceIndex];
      const destination = entries[sourceIndex + 1];
      assert.notEqual(
        source.offsetTop,
        destination.offsetTop,
        "The adjacent items should cross a visual row boundary",
      );
      const destinationID = Number(destination.dataset.itemId);
      let scrollOptions: ScrollIntoViewOptions | undefined;
      const originalScrollIntoView = destination.scrollIntoView;
      destination.scrollIntoView = (
        options?: boolean | ScrollIntoViewOptions,
      ) => {
        if (typeof options === "object") scrollOptions = options;
      };

      grid.blur();
      source.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => pane.getSelectedItems(true)[0] === Number(source.dataset.itemId),
        "Click should establish the keyboard navigation start",
      );
      assert.strictEqual(win.document.activeElement, grid);
      assert.equal(grid.getAttribute("role"), "listbox");
      assert.equal(grid.getAttribute("aria-multiselectable"), "true");
      assert.equal(grid.getAttribute("aria-activedescendant"), source.id);

      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(
        () => pane.getSelectedItems(true)[0] === destinationID,
        "Right Arrow should update Zotero's selection",
      );

      assert.equal(grid.getAttribute("aria-activedescendant"), destination.id);
      assert.equal(destination.getAttribute("aria-selected"), "true");
      assert.notEqual(win.getComputedStyle(destination).outlineStyle, "dotted");
      assert.deepEqual(scrollOptions, { block: "nearest", inline: "nearest" });

      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(20);
      assert.equal(grid.getAttribute("aria-activedescendant"), destination.id);
      assert.deepEqual(pane.getSelectedItems(true), [destinationID]);

      for (let index = sourceIndex; index >= 0; index--) {
        const expected = entries[index];
        grid.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "ArrowLeft",
            bubbles: true,
            cancelable: true,
          }),
        );
        await waitFor(
          () =>
            pane.getSelectedItems(true)[0] === Number(expected.dataset.itemId),
          "Left Arrow should select each preceding displayed item",
        );
        assert.equal(grid.getAttribute("aria-activedescendant"), expected.id);
      }
      const first = entries[0];
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(20);
      assert.equal(grid.getAttribute("aria-activedescendant"), first.id);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(first.dataset.itemId),
      ]);

      for (let index = 1; index <= sourceIndex + 1; index++) {
        const expected = entries[index];
        grid.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
        await waitFor(
          () =>
            pane.getSelectedItems(true)[0] === Number(expected.dataset.itemId),
          "Right Arrow should select each following displayed item",
        );
      }
      destination.scrollIntoView = originalScrollIntoView;
    } finally {
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates adjacent visual rows and follows responsive reflow", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = Array.from({ length: 7 }, () => new Zotero.Item("book"));
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    const press = (key: string) =>
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    const waitForSelection = async (itemID: number) => {
      const deadline = Date.now() + 2000;
      while (
        pane.getSelectedItems(true)[0] !== itemID &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(20);
      }
      assert.deepEqual(pane.getSelectedItems(true), [itemID]);
    };

    try {
      const titlePrefix = `Spatial navigation ${Date.now()}`;
      for (const [index, item] of items.entries()) {
        item.setField("title", `${titlePrefix} ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.gridTemplateColumns = "repeat(3, 150px)";

      const deadline = Date.now() + 2000;
      while (
        !items.every((item) =>
          grid.querySelector(`[data-item-id="${item.id}"]`),
        ) &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(20);
      }
      const entries = Array.from(
        grid.querySelectorAll<HTMLElement>(".grid-view-item"),
      );
      assert.lengthOf(entries, 7);
      assert.equal(entries[0].offsetTop, entries[2].offsetTop);
      assert.notEqual(entries[2].offsetTop, entries[3].offsetTop);

      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[4].dataset.itemId));
      press("ArrowUp");
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowUp");
      await Zotero.Promise.delay(20);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(entries[1].dataset.itemId),
      ]);

      entries[5].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[5].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[6].dataset.itemId));
      press("ArrowDown");
      await Zotero.Promise.delay(20);
      assert.deepEqual(pane.getSelectedItems(true), [
        Number(entries[6].dataset.itemId),
      ]);

      grid.style.gridTemplateColumns = "repeat(2, 150px)";
      assert.equal(entries[0].offsetTop, entries[1].offsetTop);
      assert.notEqual(entries[1].offsetTop, entries[2].offsetTop);
      entries[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitForSelection(Number(entries[1].dataset.itemId));
      press("ArrowDown");
      await waitForSelection(Number(entries[3].dataset.itemId));

      press("Home");
      await waitForSelection(Number(entries[0].dataset.itemId));
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[0].id);
      press("End");
      await waitForSelection(Number(entries[6].dataset.itemId));
      assert.equal(grid.getAttribute("aria-activedescendant"), entries[6].id);
    } finally {
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("navigates Home and End while preserving finite lazy rendering", function () {
    const win = Zotero.getMainWindow()!;
    const host = win.document.createElement("div");
    const originalIntersectionObserver = win.IntersectionObserver;
    const requestedItemIDs: number[] = [];
    const originalGetCover = CoverProvider.getCover;

    class FakeIntersectionObserver {
      constructor(
        _callback: IntersectionObserverCallback,
        _options?: IntersectionObserverInit,
      ) {}
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    win.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    CoverProvider.getCover = (itemID) => {
      requestedItemIDs.push(itemID);
      return Promise.resolve(null);
    };

    const items = Array.from(
      { length: 241 },
      (_, index) =>
        ({
          id: -(index + 1),
          firstCreator: "",
          getDisplayTitle: () => `Endpoint item ${index}`,
          isFileAttachment: () => false,
          isRegularItem: () => false,
        }) as unknown as Zotero.Item,
    );
    let focusedID = items[117].id;
    const renderer = new GridRenderer(
      host,
      () => {},
      undefined,
      (command) => {
        const destinationID =
          command === "home"
            ? items[0].id
            : command === "end"
              ? items.at(-1)!.id
              : command === "down"
                ? renderer.getVerticalDestination(focusedID, 1)
                : undefined;
        if (destinationID === undefined) return;
        focusedID = destinationID;
        renderer.setFocusedItem(focusedID, true);
      },
    );

    try {
      host.style.display = "grid";
      host.style.gridTemplateColumns = "repeat(3, 150px)";
      win.document
        .getElementById("cover-view-grid")!
        .parentElement!.append(host);
      renderer.setItems(items, { showAuthors: true });
      renderer.setFocusedItem(focusedID);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 120);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items[120].id);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 240);
      assert.isEmpty(requestedItemIDs);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items.at(-1)!.id);
      assert.lengthOf(host.querySelectorAll(".grid-view-item"), 241);
      assert.equal(
        host.getAttribute("aria-activedescendant"),
        host.querySelector<HTMLElement>(`[data-item-id="${focusedID}"]`)!.id,
      );
      assert.isEmpty(requestedItemIDs);

      host.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(focusedID, items[0].id);
      assert.isEmpty(requestedItemIDs);
    } finally {
      renderer.destroy();
      host.remove();
      CoverProvider.getCover = originalGetCover;
      win.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("keeps an empty grid focusable and ignores horizontal navigation", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const grid = win.document.getElementById("cover-view-grid")!;
    const deadline = Date.now() + 2000;
    while (grid.querySelector(".grid-view-item") && Date.now() < deadline) {
      await Zotero.Promise.delay(20);
    }
    assert.notExists(grid.querySelector(".grid-view-item"));

    grid.blur();
    grid.focus();
    grid.dispatchEvent(new win.FocusEvent("focus"));
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      grid.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    assert.strictEqual(win.document.activeElement, grid);
    assert.equal(grid.getAttribute("role"), "listbox");
    assert.notExists(grid.getAttribute("aria-activedescendant"));
    assert.isEmpty(pane.getSelectedItems(true));
  });

  it("preserves grid state while a reader tab is active", async function () {
    const win = Zotero.getMainWindow()!;
    const pane = win.ZoteroPane;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const items = [new Zotero.Item("book"), new Zotero.Item("book")];
    const toggle = () => button.dispatchEvent(new win.Event("command"));
    const gridStyle = grid.style.cssText;
    let readerTabID: string | undefined;

    try {
      for (const [index, item] of items.entries()) {
        item.setField("title", `Reader tab refresh test ${index}`);
        await item.saveTx();
      }
      if (grid.hidden) toggle();
      grid.style.cssText += "; height: 120px; flex: 0 0 120px";
      await pane.selectItems([items[0].id], true);
      await Zotero.Promise.delay(100);
      const firstEntry = grid.querySelector(`[data-item-id="${items[0].id}"]`)!;
      assert.exists(firstEntry);
      assert.isAbove(grid.scrollHeight, grid.clientHeight);
      grid.scrollTop = 50;
      const scrollTop = grid.scrollTop;
      readerTabID = win.Zotero_Tabs.add({
        type: "reader",
        title: "Reader tab refresh test",
        data: { itemID: items[0].id },
        select: true,
      }).id;

      items[0].setField("title", "Reader tab updated title");
      await items[0].saveTx();
      await Zotero.Promise.delay(100);
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${items[0].id}"]`),
        firstEntry,
        "The grid should not render while its tab is hidden",
      );
      win.Zotero_Tabs.select("zotero-pane");
      await Zotero.Promise.delay(100);

      for (const item of items) {
        assert.exists(grid.querySelector(`[data-item-id="${item.id}"]`));
      }
      assert.strictEqual(
        grid.querySelector(`[data-item-id="${items[0].id}"]`),
        firstEntry,
      );
      assert.equal(grid.scrollTop, scrollTop);

      toggle();
      toggle();
      assert.equal(grid.scrollTop, scrollTop);
      assert.equal(
        grid.querySelector(`[data-item-id="${items[0].id}"] .grid-view-title`)
          ?.textContent,
        "Reader tab updated title",
      );
    } finally {
      win.Zotero_Tabs.select("zotero-pane");
      if (readerTabID) win.Zotero_Tabs.close(readerTabID);
      grid.style.cssText = gridStyle;
      if (grid.hidden) toggle();
      for (const item of items) {
        if (item.id) await item.eraseTx();
      }
    }
  });

  it("applies the enableGridView preference and updates it from the toolbar", async function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;
    const originalEnableGridView = getPref("enableGridView");

    try {
      setPref("enableGridView", false);
      await Zotero.Promise.delay(20);
      assert.isTrue(grid.hidden);
      assert.notEqual(win.getComputedStyle(itemTree).display, "none");

      button.dispatchEvent(new win.Event("command"));
      await Zotero.Promise.delay(20);
      assert.isTrue(getPref("enableGridView"));
      assert.isFalse(grid.hidden);
      assert.equal(win.getComputedStyle(itemTree).display, "none");
    } finally {
      setPref("enableGridView", originalEnableGridView);
      await Zotero.Promise.delay(20);
    }
  });

  it("toggles between the cover grid and native item list", function () {
    const win = Zotero.getMainWindow()!;
    const button = win.document.getElementById("cover-view-toggle")!;
    const noteButton = win.document.getElementById("zotero-tb-note-add")!;
    const grid = win.document.getElementById("cover-view-grid")!;
    const itemTree = win.document.getElementById("zotero-items-tree")!;
    const icon = () => win.getComputedStyle(button).listStyleImage;

    assert.strictEqual(noteButton.nextElementSibling, button);
    assert.isTrue(button.hasAttribute("checked"));
    assert.include(icon(), "list-view.svg");
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isFalse(button.hasAttribute("checked"));
    assert.include(icon(), "grid-view.svg");
    assert.isTrue(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "none");
    assert.notEqual(itemTree.style.display, "none");
    assert.notEqual(win.getComputedStyle(itemTree).display, "none");

    button.dispatchEvent(new win.Event("command"));

    assert.isTrue(button.hasAttribute("checked"));
    assert.include(icon(), "list-view.svg");
    assert.isFalse(grid.hidden);
    assert.equal(win.getComputedStyle(grid).display, "grid");
    assert.equal(itemTree.style.display, "none");
    assert.equal(win.getComputedStyle(itemTree).display, "none");
  });
});
