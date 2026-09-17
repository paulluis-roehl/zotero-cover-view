import { initLocale } from "./utils/locale";
import { registerCoverColumn } from "./modules/coverColumn";
import {
  attachGridView,
  destroyGridViews,
  detachGridView,
} from "./modules/gridView";
import { registerPreferences } from "./modules/preferences";
import { CoverProvider } from "./modules/coverProvider";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPreferences();
  CoverProvider.registerNotifier();

  await registerCoverColumn();

  for (const win of Zotero.getMainWindows()) onMainWindowLoad(win);

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

function onMainWindowLoad(win: _ZoteroTypes.MainWindow): void {
  attachGridView(win);
}

function onMainWindowUnload(win: Window): void {
  detachGridView(win);
}

function onShutdown(): void {
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
