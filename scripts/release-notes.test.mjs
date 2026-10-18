import assert from "node:assert/strict";
import test from "node:test";
import { releaseNotes } from "./release-notes.mjs";

test("extracts a dated version, preserving categories and collapsing commits", () => {
  const changelog = `# Changelog
## [Unreleased]
- Future change
## [0.6.0] - 2026-10-18
### Added
- New feature
### Fixed
- Bug fix
## [0.5.0] - 2026-09-01
- Older change`;
  assert.equal(
    releaseNotes(changelog, "0.6.0", "- feat: new feature"),
    "### Added\n- New feature\n### Fixed\n- Bug fix\n\n<details>\n<summary>Development details</summary>\n\n- feat: new feature\n\n</details>",
  );
});

test("supports legacy headings, CRLF, prereleases, and trailing link definitions", () => {
  const changelog =
    "## 0.6.0-beta.1\r\n\r\n- Preview\r\n\r\n[Unreleased]: https://example.com/compare\r\n";
  assert.equal(releaseNotes(changelog, "0.6.0-beta.1", ""), "- Preview");
});

test("falls back to generated notes for missing or empty versions", () => {
  for (const changelog of ["## [Unreleased]\n- Future", "## [0.6.0]\n\n"]) {
    assert.equal(releaseNotes(changelog, "0.6.0", "Generated"), "Generated");
  }
});
