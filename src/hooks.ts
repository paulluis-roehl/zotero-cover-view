import { initLocale } from "./utils/locale";
import {
  registerCoverColumn,
  unregisterCoverColumn,
} from "./modules/coverColumn";
import {
  attachGridView,
  destroyGridViews,
  detachGridView,
} from "./modules/gridView";
import { registerPreferences } from "./modules/preferences";
import { CoverProvider } from "./modules/coverProvider";
import {
  attachItemPaneCoverWindow,
  detachItemPaneCoverWindow,
  registerItemPaneCover,
  unregisterItemPaneCover,
} from "./modules/itemPaneCover";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPreferences();
  CoverProvider.registerNotifier();
  registerItemPaneCover();

  await registerCoverColumn();

  for (const win of Zotero.getMainWindows()) onMainWindowLoad(win);

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

function onMainWindowLoad(win: _ZoteroTypes.MainWindow): void {
  attachItemPaneCoverWindow(win);
  attachGridView(win);
}

function onMainWindowUnload(win: Window): void {
  detachItemPaneCoverWindow(win);
  detachGridView(win);
}

function onShutdown(): void {
  unregisterCoverColumn();
  unregisterItemPaneCover();
  destroyGridViews();
  CoverProvider.unregisterNotifier();
  CoverProvider.clearCache();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
