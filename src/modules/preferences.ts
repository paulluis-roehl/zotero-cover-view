import { getString } from "../utils/locale";

export function registerPreferences(): void {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    stylesheets: [`${rootURI}content/preferences.css`],
    scripts: [`${rootURI}content/scripts/preferences.js`],
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });
}
