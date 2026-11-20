/**
 * Project-owned files and data for tests: a per-run scratch directory,
 * generated image/PDF/EPUB files, invented bibliographic data, unique ISBNs
 * and a scoped Open Library interceptor.
 *
 * Every test file is bundled separately, so run-wide state lives on a shared
 * global and its hooks are registered once for the whole run.
 */

const PROJECT = "zotero-cover-view-tests";

export interface OpenLibraryReply {
  status?: number;
  bytes?: Uint8Array;
  json?: unknown;
}

export type OpenLibraryHandler = (
  url: string,
) => OpenLibraryReply | Promise<OpenLibraryReply>;

export interface OpenLibraryInterceptor {
  /** Open Library URLs requested while this interceptor was active. */
  readonly requests: string[];
  restore(): void;
}

interface ActiveInterceptor {
  handler: OpenLibraryHandler;
  requests: string[];
}

interface SharedState {
  runDirectory: string;
  sequence: number;
  seed: number;
  isbns: Set<string>;
  editionKeys: Set<string>;
  titles: Set<string>;
  interceptors: ActiveInterceptor[];
  originalRequest?: typeof Zotero.HTTP.request;
}

const STATE_KEY = Symbol.for("zotero-cover-view.testEnvironment");

const state: SharedState = ((globalThis as Record<symbol, unknown>)[
  STATE_KEY
] ??= createState()) as SharedState;

function createState(): SharedState {
  const created: SharedState = {
    runDirectory: PathUtils.join(
      PathUtils.tempDir,
      `${PROJECT}-${Date.now()}-${Zotero.Utilities.randomString(6)}`,
    ),
    sequence: 0,
    seed: Math.floor(Math.random() * 100_000_000),
    isbns: new Set(),
    editionKeys: new Set(),
    titles: new Set(),
    interceptors: [],
  };
  // Root hooks run after every test and after the run, even on failure.
  before(removeAbandonedRunDirectories);
  afterEach(restoreAllInterceptors);
  after(async function () {
    restoreAllInterceptors();
    await IOUtils.remove(created.runDirectory, {
      recursive: true,
      ignoreAbsent: true,
    });
    await forgetOnlineCovers(created);
  });
  return created;
}

/** Remove run directories left behind by runs that were killed a day ago. */
async function removeAbandonedRunDirectories(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const path of await IOUtils.getChildren(PathUtils.tempDir)) {
    const started = PathUtils.filename(path).match(
      new RegExp(`^${PROJECT}-(\\d+)-`),
    )?.[1];
    if (!started || Number(started) >= cutoff) continue;
    try {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
    } catch (error) {
      Zotero.debug(
        `Could not remove abandoned test directory ${path}: ${error}`,
      );
    }
  }
}

function nextSequence(): number {
  return state.sequence++;
}

// Scratch files ---------------------------------------------------------------

/** The run's scratch directory under the OS temp directory. */
export function runDirectory(): string {
  return state.runDirectory;
}

/** A fresh, empty directory inside the run's scratch directory. */
export async function scratchDirectory(): Promise<string> {
  const directory = PathUtils.join(
    state.runDirectory,
    `${nextSequence()}-${Zotero.Utilities.randomString(6)}`,
  );
  await IOUtils.makeDirectory(directory, { createAncestors: true });
  return directory;
}

/** Write a file with the given name into a fresh scratch directory. */
export async function scratchFile(
  name: string,
  contents: Uint8Array | string = new Uint8Array(),
): Promise<string> {
  const path = PathUtils.join(await scratchDirectory(), name);
  await IOUtils.write(
    path,
    typeof contents === "string"
      ? new TextEncoder().encode(contents)
      : contents,
  );
  return path;
}

// Generated files -------------------------------------------------------------

/** Real image bytes drawn on a canvas. */
export function imageBytes(
  width: number,
  height: number,
  type: "image/png" | "image/jpeg" = "image/png",
  { fill = "#000000", lowerFill }: { fill?: string; lowerFill?: string } = {},
): Uint8Array {
  const win = Zotero.getMainWindow()!;
  const canvas = win.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")! as CanvasRenderingContext2D;
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  if (lowerFill) {
    context.fillStyle = lowerFill;
    context.fillRect(0, height / 2, width, height / 2);
  }
  return Uint8Array.from(win.atob(canvas.toDataURL(type).split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
}

export interface PDFOptions {
  /** Page size in points. */
  width?: number;
  height?: number;
  /** The page's content stream. Defaults to "Cover" in Helvetica. */
  content?: string;
  /** Raw page dictionary entries besides /MediaBox and /Contents. */
  page?: string;
  /**
   * Raw objects numbered from 5 on; 1 to 4 are the catalog, page tree, page
   * and content stream.
   */
  objects?: string[];
  /** Content streams of further pages of the same size, numbered after `objects`. */
  morePages?: string[];
}

/** A PDF stream object with the given dictionary entries and ASCII data. */
export function pdfStream(dictionary: string, data: string): string {
  return `<< ${dictionary} /Length ${data.length} >>\nstream\n${data}\nendstream`;
}

/** A minimal valid PDF, by default one page with the given page size in points. */
export function pdfBytes({
  width = 200,
  height = 300,
  content = `BT /F1 24 Tf 30 ${Math.round(height / 2)} Td (Cover) Tj ET`,
  page = "/Resources << /Font << /F1 5 0 R >> >>",
  objects: extra = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  morePages = [],
}: PDFOptions = {}): Uint8Array {
  // Further page dictionaries come together, before their content streams.
  const firstMore = 5 + extra.length;
  const kids = [3, ...morePages.map((_, index) => firstMore + index)];
  const pageObject = (entries: string, contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ${entries} /Contents ${contents} 0 R >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`,
    pageObject(page, 4),
    pdfStream("", content),
    ...extra,
    ...morePages.map((_, index) =>
      pageObject("", firstMore + morePages.length + index),
    ),
    ...morePages.map((pageContent) => pdfStream("", pageContent)),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export interface EPUBOptions {
  /** Archive path of the package document named by container.xml. */
  packagePath?: string;
  /** Raw `<manifest>` children. Defaults to a cover image item. */
  manifest?: string;
  /** Raw `<metadata>` children. */
  metadata?: string;
  /** Additional or replacement archive entries, by literal archive path. */
  entries?: Record<string, string | Uint8Array>;
}

/**
 * A real EPUB (ZIP) archive. By default it declares an EPUB 3 cover image at
 * `OPS/cover.png` and contains that image.
 */
export function epubBytes({
  packagePath = "OPS/package.opf",
  manifest,
  metadata = "",
  entries = {},
}: EPUBOptions = {}): Uint8Array {
  const defaults: Record<string, string | Uint8Array> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${escapeXML(packagePath)}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    [packagePath]: `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata>${metadata}</metadata>
  <manifest>${
    manifest ??
    '<item id="cover" properties="cover-image" href="cover.png" media-type="image/png"/>'
  }</manifest>
</package>`,
  };
  if (manifest === undefined) {
    const directory = packagePath.split("/").slice(0, -1);
    defaults[[...directory, "cover.png"].join("/")] = imageBytes(40, 60);
  }
  return zipStored({ ...defaults, ...entries });
}

function escapeXML(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
}

/** Uncompressed ZIP archive, entries in insertion order. */
function zipStored(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data =
      typeof contents === "string" ? encoder.encode(contents) : contents;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const archive = new Uint8Array(
    parts.reduce((size, chunk) => size + chunk.length, 0),
  );
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return archive;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Invented bibliographic data -------------------------------------------------

const ADJECTIVES = [
  "Amber",
  "Brindled",
  "Copper",
  "Drowsy",
  "Gilded",
  "Hollow",
  "Lantern-lit",
  "Moss-grown",
  "Quiet",
  "Silvered",
  "Tidewater",
  "Wandering",
];
const NOUNS = [
  "Almanac",
  "Archive",
  "Cartographer",
  "Ferryman",
  "Glasshouse",
  "Lighthouse",
  "Orchard",
  "Saltworks",
  "Telescope",
  "Weathervane",
];
const PLACES = [
  "Brackwater Fen",
  "Calloway Reach",
  "Esterquill",
  "Fallowmere",
  "Harrowdeep",
  "Knotwillow",
  "Quillmere",
  "Varrowby",
];
const FIRST_NAMES = [
  "Odile",
  "Fennimore",
  "Isolde",
  "Barnaby",
  "Ottoline",
  "Caspian",
  "Wilhelmina",
  "Peregrine",
];
const LAST_NAMES = [
  "Brackwater",
  "Quist",
  "Thistlewood",
  "Marrowby",
  "Penhallow",
  "Ashgrove",
  "Fenwick-Lowe",
  "Tallowmere",
];
const PUBLISHERS = [
  "Lanternfold Press",
  "Quillmere Books",
  "Harrowdeep & Daughters",
  "Saltworks Editions",
];

export interface InventedCreator {
  firstName: string;
  lastName: string;
}

export interface InventedBook {
  title: string;
  creator: InventedCreator;
  year: string;
  publisher: string;
}

function pick<T>(values: T[], index: number): T {
  return values[index % values.length];
}

/** An invented creator. Names are not unique across calls. */
function inventCreator(): InventedCreator {
  const value = state.seed + nextSequence();
  return {
    firstName: pick(FIRST_NAMES, value),
    lastName: pick(LAST_NAMES, Math.floor(value / FIRST_NAMES.length)),
  };
}

/**
 * An invented book whose title is unique within the run. Saved metadata
 * cover lookups for invented titles are removed after the run.
 */
export function inventBook(): InventedBook {
  const sequence = nextSequence();
  const value = state.seed + sequence;
  const title = `The ${pick(ADJECTIVES, value)} ${pick(NOUNS, Math.floor(value / ADJECTIVES.length))} of ${pick(PLACES, Math.floor(value / (ADJECTIVES.length * NOUNS.length)))}, Volume ${sequence + 1}`;
  state.titles.add(title);
  return {
    title,
    creator: inventCreator(),
    year: String(1900 + (value % 120)),
    publisher: pick(PUBLISHERS, value),
  };
}

// Identifiers -----------------------------------------------------------------

/**
 * A checksum-valid ISBN-13, unique within the run, in the unallocated
 * registration group 979-5 so that it never names a real book. Online cover
 * cache entries for generated ISBNs are removed after the run.
 */
export function uniqueISBN(): string {
  const payload = String((state.seed + nextSequence()) % 100_000_000).padStart(
    8,
    "0",
  );
  const digits = `9795${payload}`;
  let sum = 0;
  for (let index = 0; index < 12; index++)
    sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
  const isbn = `${digits}${(10 - (sum % 10)) % 10}`;
  state.isbns.add(isbn);
  return isbn;
}

/**
 * An Open Library edition key far beyond the range of real records, unique
 * within the run. Its online cover cache entries are removed after the run.
 */
export function uniqueEditionKey(): string {
  const key = `OL9${String((state.seed + nextSequence()) % 100_000_000).padStart(11, "0")}M`;
  state.editionKeys.add(key);
  return key;
}

function onlineCoverCache(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "coverview",
    "covers",
    "open-library",
  );
}

async function forgetOnlineCovers(shared: SharedState): Promise<void> {
  const cache = onlineCoverCache();
  const paths = [
    ...[...shared.isbns].map((isbn) => PathUtils.join(cache, isbn)),
    ...[...shared.editionKeys].map((key) => PathUtils.join(cache, "olid", key)),
  ];
  for (const base of paths)
    for (const extension of [".jpg", ".jpg.tmp", ".missing", ".missing.tmp"])
      await IOUtils.remove(`${base}${extension}`, { ignoreAbsent: true });
  const searches = PathUtils.join(cache, "olid", "search");
  if (!(await IOUtils.exists(searches))) return;
  for (const path of await IOUtils.getChildren(searches)) {
    try {
      const [title] = JSON.parse(
        JSON.parse(await IOUtils.readUTF8(path)).query,
      );
      if (shared.titles.has(title))
        await IOUtils.remove(path, { ignoreAbsent: true });
    } catch {
      // Not a saved search for an invented title.
    }
  }
}

// Open Library interception ---------------------------------------------------

function isOpenLibraryURL(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "openlibrary.org" || hostname.endsWith(".openlibrary.org")
    );
  } catch {
    return false;
  }
}

/**
 * Answer Open Library requests with `handler` until restored. Other requests,
 * such as the test reporter's, pass through to Zotero. Interceptors are
 * restored automatically after every test, including failing ones; the most
 * recently installed one answers.
 */
export function interceptOpenLibrary(
  handler: OpenLibraryHandler,
): OpenLibraryInterceptor {
  const active: ActiveInterceptor = { handler, requests: [] };
  if (!state.interceptors.length) {
    const original = Zotero.HTTP.request;
    state.originalRequest = original;
    Zotero.HTTP.request = (async (
      method: string,
      url: string,
      options?: { successCodes?: number[] | false },
    ) => {
      const current = state.interceptors.at(-1);
      if (!current || !isOpenLibraryURL(url))
        return original.call(Zotero.HTTP, method, url, options as never);
      current.requests.push(url);
      const reply = await current.handler(url);
      const status = reply.status ?? 200;
      const success = options?.successCodes
        ? options.successCodes.includes(status)
        : options?.successCodes === false ||
          (status >= 200 && status < 300) ||
          status === 304;
      if (!success) throw new Error(`Unexpected status ${status} for ${url}`);
      const bytes =
        reply.bytes ??
        new TextEncoder().encode(
          reply.json === undefined ? "" : JSON.stringify(reply.json),
        );
      return { status, response: bytes.slice().buffer };
    }) as typeof Zotero.HTTP.request;
  }
  state.interceptors.push(active);
  return {
    requests: active.requests,
    restore: () => restoreInterceptor(active),
  };
}

function restoreInterceptor(active: ActiveInterceptor): void {
  const index = state.interceptors.indexOf(active);
  if (index < 0) return;
  state.interceptors.splice(index, 1);
  if (!state.interceptors.length && state.originalRequest) {
    Zotero.HTTP.request = state.originalRequest;
    state.originalRequest = undefined;
  }
}

function restoreAllInterceptors(): void {
  for (const active of [...state.interceptors].reverse())
    restoreInterceptor(active);
}

/** A stand-in for Open Library, answering through an interceptor. */
export interface FakeOpenLibrary {
  /** Open Library URLs requested while the fake was active. */
  readonly requests: string[];
  /** When false, every request fails with a server error. */
  available: boolean;
  /** Serve `bytes` as the cover of the book with this ISBN. */
  addISBNCover(isbn: string, bytes: Uint8Array): void;
  /** Serve `bytes` as the cover of the edition with this key. */
  addEditionCover(key: string, bytes: Uint8Array): void;
  /** Answer a search for `title` by `author` with these result documents. */
  addSearchResults(title: string, author: string, docs: unknown[]): void;
  /**
   * Make `bytes` the cover found by searching for `title` by `author`, and
   * return the key of the cover's edition.
   */
  addBook(title: string, author: string, bytes: Uint8Array): string;
}

/**
 * Answer Open Library requests like Open Library would, from the covers and
 * search results added to the returned fake. Unknown covers are missing (404)
 * and unknown searches find nothing. Restored like `interceptOpenLibrary`.
 */
export function fakeOpenLibrary(): FakeOpenLibrary {
  const isbnCovers = new Map<string, Uint8Array>();
  const editionCovers = new Map<string, Uint8Array>();
  const searches = new Map<string, unknown[]>();
  const searchKey = (title: string, author: string) =>
    JSON.stringify([title, author]);
  const { requests } = interceptOpenLibrary((url) => {
    if (!fake.available) return { status: 500 };
    const { pathname, searchParams } = new URL(url);
    const cover = pathname.match(/^\/b\/(isbn|olid)\/(.+)-L\.jpg$/);
    if (cover) {
      const bytes = (cover[1] === "isbn" ? isbnCovers : editionCovers).get(
        decodeURIComponent(cover[2]),
      );
      return bytes ? { bytes } : { status: 404 };
    }
    const query = searchParams.get("q")?.match(/^title:(.*) author:(.*)$/s);
    if (pathname === "/search.json" && query)
      return {
        json: { docs: searches.get(searchKey(query[1], query[2])) ?? [] },
      };
    return { status: 404 };
  });
  const fake: FakeOpenLibrary = {
    requests,
    available: true,
    addISBNCover: (isbn, bytes) => void isbnCovers.set(isbn, bytes),
    addEditionCover: (key, bytes) => void editionCovers.set(key, bytes),
    addSearchResults: (title, author, docs) =>
      void searches.set(searchKey(title, author), docs),
    addBook(title, author, bytes) {
      const key = uniqueEditionKey();
      fake.addSearchResults(title, author, [{ cover_edition_key: key }]);
      fake.addEditionCover(key, bytes);
      return key;
    },
  };
  return fake;
}

/** The natural size of the image at `uri`. */
export async function imageSize(
  uri: string,
): Promise<{ width: number; height: number }> {
  const image = new (Zotero.getMainWindow()!.Image)();
  image.src = uri;
  await image.decode();
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/**
 * Coarse visual features of the image at `uri`: its average colour as
 * `[red, green, blue]`, and the share of its pixels that are not near white.
 */
export async function imagePaint(
  uri: string,
): Promise<{ colour: [number, number, number]; inked: number }> {
  const win = Zotero.getMainWindow()!;
  const image = new win.Image();
  image.src = uri;
  await image.decode();
  const canvas = win.document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d")! as CanvasRenderingContext2D;
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const sum: [number, number, number] = [0, 0, 0];
  let inked = 0;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++)
      sum[channel] += data[index + channel];
    if (Math.min(data[index], data[index + 1], data[index + 2]) < 200) inked++;
  }
  const pixels = data.length / 4;
  return {
    colour: sum.map((value) => value / pixels) as [number, number, number],
    inked: inked / pixels,
  };
}
