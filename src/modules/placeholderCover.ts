export function createPlaceholderCoverURI(item: Zotero.Item): string {
  const title = item.getDisplayTitle?.().trim() || "Untitled";
  const author = item.firstCreator?.trim() || "";
  const year = String(item.getField?.("date") ?? "").match(/\b\d{4}\b/)?.[0];
  let hash = 0;
  for (const character of title) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  const titleLines = wrapText(title, 20, 7);
  const lineHeight = titleLines.length > 5 ? 32 : 40;
  const titleSize = titleLines.length > 5 ? 26 : 32;
  const titleStart = 265 - ((titleLines.length - 1) * lineHeight) / 2;
  const titleMarkup = titleLines
    .map(
      (line, index) =>
        `<tspan x="230" y="${titleStart + index * lineHeight}">${escapeXML(line)}</tspan>`,
    )
    .join("");
  const authorMarkup = author
    ? `<text x="230" y="490" text-anchor="middle" fill="hsl(${hue} 30% 51%)" font-family="system-ui, sans-serif" font-size="19" font-weight="400">${escapeXML(truncateText(author, 34))}</text>`
    : "";
  const yearMarkup = year
    ? `<text x="382" y="38" text-anchor="end" dominant-baseline="hanging" fill="hsl(${hue} 30% 51%)" font-family="system-ui, sans-serif" font-size="19" font-weight="500">${year}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 594"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 45% 86%)"/><stop offset="1" stop-color="hsl(${hue} 42% 70%)"/></linearGradient><clipPath id="content"><rect x="60" y="90" width="340" height="430"/></clipPath></defs><rect width="420" height="594" rx="12" fill="url(#g)"/><path d="M34 38h6v518h-6z" fill="hsl(${hue} 38% 42%)" opacity=".45"/>${yearMarkup}<g clip-path="url(#content)"><text text-anchor="middle" fill="hsl(${hue} 42% 28%)" font-family="system-ui, sans-serif" font-size="${titleSize}" font-weight="600">${titleMarkup}</text>${authorMarkup}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function wrapText(
  value: string,
  maxCharacters: number,
  maxLines: number,
): string[] {
  const words = value
    .split(/\s+/)
    .flatMap((word) =>
      word.length > maxCharacters
        ? (word.match(new RegExp(`.{1,${maxCharacters}}`, "g")) ?? [word])
        : [word],
    );
  const lines: string[] = [];
  let line = "";

  for (let index = 0; index < words.length; index++) {
    const candidate = line ? `${line} ${words[index]}` : words[index];
    if (candidate.length <= maxCharacters) {
      line = candidate;
      continue;
    }

    if (lines.length === maxLines - 1) {
      const remainder = [line, ...words.slice(index)].filter(Boolean).join(" ");
      lines.push(truncateText(remainder, maxCharacters));
      return lines;
    }
    if (line) lines.push(line);
    line = words[index];
  }

  if (line) lines.push(line);
  return lines;
}

function truncateText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 3).trimEnd()}...`;
}

function escapeXML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
