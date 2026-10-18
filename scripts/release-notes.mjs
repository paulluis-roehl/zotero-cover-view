/** Combine a version's curated changelog with the scaffold's generated notes. */
export function releaseNotes(changelog, version, developmentNotes) {
  const lines = changelog.split(/\r?\n/);
  let start = -1;
  let end = lines.length;

  for (const [index, line] of lines.entries()) {
    if (!/^##\s+/.test(line)) continue;
    if (start >= 0) {
      end = index;
      break;
    }
    // Support both Keep a Changelog headings and older bare-version headings.
    const heading = /^##\s+(?:\[([^\]]+)\]|(\S+))(?:\s|$)/.exec(line);
    if ((heading?.[1] ?? heading?.[2]) === version) start = index + 1;
  }

  if (start < 0) return developmentNotes;
  const curated = lines
    .slice(start, end)
    .filter((line) => !/^\s*\[[^\]]+\]:\s+/.test(line))
    .join("\n")
    .trim();
  if (!curated) return developmentNotes;
  if (!developmentNotes.trim()) return curated;

  return `${curated}\n\n<details>\n<summary>Development details</summary>\n\n${developmentNotes.trim()}\n\n</details>`;
}
