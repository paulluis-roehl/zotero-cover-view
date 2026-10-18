import { defineConfig } from "zotero-plugin-scaffold";
import { readFileSync } from "node:fs";
import { releaseNotes } from "./scripts/release-notes.mjs";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        entryPoints: ["src/preferencesPane.ts"],
        bundle: true,
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/scripts/preferences.js",
      },
    ],
  },

  test: {
    entries: process.env.COVER_VIEW_TEST_ENTRIES || "test",
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  release: {
    github: {
      releaseNote: (ctx) =>
        releaseNotes(
          readFileSync("CHANGELOG.md", "utf8"),
          ctx.version,
          ctx.release.changelog,
        ),
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
