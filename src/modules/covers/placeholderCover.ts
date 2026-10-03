import { getItemYear } from "../../utils/itemYear";

type PlaceholderFamily =
  "book" | "document" | "audio" | "video" | "image" | "note" | "generic";

const itemFamilies: Record<string, PlaceholderFamily> = {
  book: "book",
  bookSection: "book",
  dictionaryEntry: "book",
  encyclopediaArticle: "book",
  audioRecording: "audio",
  podcast: "audio",
  radioBroadcast: "audio",
  film: "video",
  tvBroadcast: "video",
  videoRecording: "video",
  artwork: "image",
  map: "image",
  note: "note",
  bill: "document",
  blogPost: "document",
  case: "document",
  conferencePaper: "document",
  email: "document",
  forumPost: "document",
  hearing: "document",
  instantMessage: "document",
  interview: "document",
  journalArticle: "document",
  letter: "document",
  magazineArticle: "document",
  manuscript: "document",
  newspaperArticle: "document",
  patent: "document",
  preprint: "document",
  presentation: "document",
  report: "document",
  standard: "document",
  statute: "document",
  thesis: "document",
  webpage: "document",
};

// Sparse family details leave the metadata area clear. Generic covers are
// deliberately text-only; the other families do not depend on colour alone.
const motifs: Record<PlaceholderFamily, string> = {
  book: '<path d="M38 38v518"/>',
  document:
    '<path d="M20 20h328l52 52v502M348 20v52h52M158 80h104v76H158zM174 104h72m-62 24h52"/>',
  audio:
    '<path d="M98 530v-18m28 18v-30m28 30v-12m28 12v-24m28 24v-38m28 38v-24m28 24v-12m28 12v-30m28 30v-18"/>',
  video:
    '<path d="M56 82v430M364 82v430" stroke-dasharray="14 18" stroke-width="16"/>',
  image:
    '<rect x="150" y="80" width="120" height="76"/><circle cx="238" cy="100" r="8"/><path d="M152 150l36-40 30 32 20-18 30 26"/>',
  note: '<path d="M400 20v502l-52 52H20M348 574v-52h52"/>',
  generic: "",
};

function placeholderFamily(item: Zotero.Item): PlaceholderFamily {
  if (item.isAttachment?.()) {
    const contentType = (item.attachmentContentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("audio/")) return "audio";
    if (contentType.startsWith("video/")) return "video";
    if (contentType === "application/epub+zip") return "book";
    if (contentType === "application/pdf" || contentType.startsWith("text/"))
      return "document";
    return "generic";
  }
  return Object.hasOwn(itemFamilies, item.itemType)
    ? itemFamilies[item.itemType]
    : "generic";
}

export function createPlaceholderCoverURI(item: Zotero.Item): string {
  const family = placeholderFamily(item);
  const title = item.getDisplayTitle?.().trim() || "Untitled";
  const author = item.firstCreator?.trim() || "";
  const year = getItemYear(item);
  let hash = 0;
  for (const character of title) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  const titleLines = wrapText(title, 18, 7);
  const lineHeight = titleLines.length > 5 ? 26 : 36;
  const titleSize = titleLines.length > 5 ? 24 : 28;
  const titleStart = 255 - ((titleLines.length - 1) * lineHeight) / 2;
  const yearPosition = titleStart + (titleLines.length - 1) * lineHeight + 46;
  const context = Zotero.getMainWindow()
    ?.document.createElement("canvas")
    .getContext("2d") as CanvasRenderingContext2D | null | undefined;
  // Only compress lines that would otherwise be clipped; normal text keeps
  // its natural spacing and the approved layout.
  const fitText = (value: string, size: number, weight: number): string => {
    if (!context) return "";
    context.font = `${weight} ${size}px system-ui, sans-serif`;
    return context.measureText(value).width > 280
      ? 'textLength="280" lengthAdjust="spacingAndGlyphs"'
      : "";
  };
  const titleMarkup = titleLines
    .map(
      (line, index) =>
        `<text ${fitText(line, titleSize, 600)}><tspan x="210" y="${titleStart + index * lineHeight}">${escapeXML(line)}</tspan></text>`,
    )
    .join("");
  const authorText = truncateText(author, 28);
  const authorMarkup = author
    ? `<text x="210" y="440" text-anchor="middle" fill="hsl(${hue} 38% 28%)" font-family="system-ui, sans-serif" font-size="19" font-weight="400" ${fitText(authorText, 19, 400)}>${escapeXML(authorText)}</text>`
    : "";
  const yearMarkup = year
    ? `<text data-metadata="year" x="210" y="${yearPosition}" text-anchor="middle" fill="hsl(${hue} 38% 28%)" font-family="system-ui, sans-serif" font-size="24" font-weight="500">${year}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 594" data-family="${family}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 45% 86%)"/><stop offset="1" stop-color="hsl(${hue} 42% 70%)"/></linearGradient>
      <clipPath id="content"><rect x="68" y="144" width="284" height="350"/></clipPath>
    </defs>
    <rect width="420" height="594" fill="url(#g)"/>
    <g data-motif="${family}" fill="none" stroke="hsl(${hue} 38% 32%)" stroke-width="6" stroke-linejoin="round">${motifs[family]}</g>
    ${yearMarkup}
    <g clip-path="url(#content)"><g text-anchor="middle" fill="hsl(${hue} 42% 28%)" font-family="system-ui, sans-serif" font-size="${titleSize}" font-weight="600">${titleMarkup}</g>${authorMarkup}</g>
  </svg>`;
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
