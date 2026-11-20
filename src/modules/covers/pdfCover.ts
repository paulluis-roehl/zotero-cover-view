// One shared bitmap supports previews up to 1024 CSS px at 2x density without
// tying cache entries or PDF extraction to a particular window or pane size.
const DEFAULT_COVER_EDGE = 2048;
const MAX_CANVAS_EDGE = 4096;
const MAX_CANVAS_PIXELS = 16_777_216;
const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const PDFJS_WEB_URL = "resource://zotero/reader/pdf/web/";
// PDF.js "enable": paint annotation appearances stored in the PDF itself.
const PDFJS_ANNOTATION_MODE_ENABLE = 1;
// PDFs up to the limit are read whole; larger ones in chunks, as PDF.js
// requests them.
const PDF_SMALL_FILE_LIMIT = 512 * 1024;
const PDF_RANGE_CHUNK_SIZE = 64 * 1024;

interface PDFPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    annotationMode: number;
  }): { promise: Promise<void> };
}

interface PDFDocument {
  getPage(index: number): Promise<PDFPage>;
}

interface PDFDataRangeTransport {
  onDataRange(begin: number, chunk: Uint8Array): void;
  requestDataRange(begin: number, end: number): void;
  abort(): void;
}

type PDFSource =
  | { data: Uint8Array }
  | {
      range: PDFDataRangeTransport;
      rangeChunkSize: number;
      disableStream: boolean;
      disableAutoFetch: boolean;
    };

interface PDFJSModule {
  GlobalWorkerOptions: { workerSrc: string };
  PDFDataRangeTransport: new (
    length: number,
    initialData: Uint8Array,
    progressiveDone: boolean,
  ) => PDFDataRangeTransport;
  getDocument(
    options: PDFSource & {
      cMapUrl: string;
      cMapPacked: boolean;
      standardFontDataUrl: string;
      iccUrl: string;
      wasmUrl: string;
      isEvalSupported: boolean;
    },
  ): {
    promise: Promise<PDFDocument>;
    destroy(): Promise<void>;
  };
}

const PNG_DATA_PREFIX = "data:image/png;base64,";

export function isPDFAttachment(item: Zotero.Item): boolean {
  return (
    item.isFileAttachment() &&
    (item.attachmentContentType === "application/pdf" ||
      item.attachmentReaderType === "pdf")
  );
}

const diskCacheDirectory = (): string =>
  PathUtils.join(Zotero.DataDirectory.dir, "coverview", "covers");

const diskCacheImagePath = (itemID: number): string =>
  PathUtils.join(diskCacheDirectory(), `${itemID}.png`);

const diskCacheSignaturePath = (itemID: number): string =>
  PathUtils.join(diskCacheDirectory(), `${itemID}.signature`);

export async function createPDFCacheSignature(
  attachment: Zotero.Item,
  filePath: string,
): Promise<string> {
  const { size, lastModified } = await IOUtils.stat(filePath);
  return `v4:${attachment.id}:${attachment.dateModified ?? ""}:${size ?? ""}:${lastModified ?? ""}:${filePath}`;
}

export async function getCachedPDFCover(
  itemID: number,
  signature: string,
): Promise<string | null> {
  try {
    const cachedSignature = await IOUtils.readUTF8(
      diskCacheSignaturePath(itemID),
    );
    if (cachedSignature !== signature) return null;

    const bytes = await IOUtils.read(diskCacheImagePath(itemID));
    if (!isPNG(bytes)) return null;
    return `${PNG_DATA_PREFIX}${encodeBase64(bytes)}`;
  } catch {
    return null;
  }
}

export async function cachePDFCover(
  itemID: number,
  signature: string,
  data: string,
): Promise<void> {
  try {
    if (!data.startsWith(PNG_DATA_PREFIX)) return;

    const directory = diskCacheDirectory();
    const imagePath = diskCacheImagePath(itemID);
    const signaturePath = diskCacheSignaturePath(itemID);
    await IOUtils.makeDirectory(directory, { createAncestors: true });
    await IOUtils.write(
      imagePath,
      decodeBase64(data.slice(PNG_DATA_PREFIX.length)),
      {
        tmpPath: `${imagePath}.tmp`,
      },
    );
    await IOUtils.writeUTF8(signaturePath, signature, {
      tmpPath: `${signaturePath}.tmp`,
    });
  } catch (error) {
    ztoolkit.log("Failed to write PDF cover cache", itemID, error);
  }
}

export async function deleteCachedPDFCover(itemID: number): Promise<void> {
  await Promise.all(
    [diskCacheImagePath(itemID), diskCacheSignaturePath(itemID)].map((path) =>
      IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {}),
    ),
  );
}

/**
 * Render the first page with the same PDF.js engine and decoder assets as Zotero's reader.
 *
 * Range reads and their failure handling are adapted from `localPDFSource`
 * and `renderPDF` in ZoteroThumbLibrary 0.1.10
 * (https://github.com/gchapron/ZoteroThumbLibrary), by Guillaume Chapron,
 * AGPL-3.0-or-later.
 */
export async function findPDFCoverURI(
  filePath: string,
  targetWidth?: number,
): Promise<string | null> {
  if (
    targetWidth !== undefined &&
    (!Number.isFinite(targetWidth) || targetWidth <= 0)
  ) {
    throw new Error("PDF cover width must be a positive number");
  }

  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Cannot render PDF cover without a Zotero window");
  // Import in the window realm: Zotero's sandbox freezes Map.prototype, while
  // the reader's PDF.js module installs a Map polyfill during initialization.
  const pdfjs = (await win.eval(
    `import("${PDFJS_MODULE_URL}")`,
  )) as PDFJSModule;
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  // PDF.js waits forever for a range that never arrives; fail the render instead.
  let failRead!: (error: unknown) => void;
  const readFailure = new Promise<never>((_, reject) => (failRead = reject));
  const { source, abort } = await localPDFSource(pdfjs, filePath, failRead);
  let task: ReturnType<PDFJSModule["getDocument"]> | undefined;
  try {
    task = pdfjs.getDocument({
      ...source,
      // Zotero's bundled resources only: local resource:// URLs, no network.
      cMapUrl: `${PDFJS_WEB_URL}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_WEB_URL}standard_fonts/`,
      iccUrl: `${PDFJS_WEB_URL}iccs/`,
      wasmUrl: `${PDFJS_WEB_URL}wasm/`,
      // Defence in depth: PDF.js 5 never evaluates PDF code when rendering and
      // ignores this option; PDF.js 4 and earlier honour it.
      isEvalSupported: false,
    });
    return await Promise.race([
      readFailure,
      task.promise.then((document) =>
        renderFirstPage(win, document, targetWidth),
      ),
    ]);
  } finally {
    abort();
    // A failed cleanup must not replace the cover or the original error.
    await task?.destroy().catch(() => {});
  }
}

/**
 * The PDF at `path` as a PDF.js source. Small files are read whole; larger
 * ones are read in ranges as PDF.js requests them, reporting failed reads to
 * `onError`. `abort` ignores outstanding and further reads.
 */
async function localPDFSource(
  pdfjs: PDFJSModule,
  path: string,
  onError: (error: unknown) => void,
): Promise<{ source: PDFSource; abort(): void }> {
  const { size } = await IOUtils.stat(path);
  if (size === undefined || size <= PDF_SMALL_FILE_LIMIT) {
    return {
      source: { data: new Uint8Array(await IOUtils.read(path)) },
      abort() {},
    };
  }

  const initialData = await readRange(path, 0, PDF_RANGE_CHUNK_SIZE);
  let aborted = false;
  const range = new pdfjs.PDFDataRangeTransport(size, initialData, true);
  range.requestDataRange = (begin, end) => {
    if (aborted) return;
    readRange(path, begin, end)
      .then((bytes) => {
        if (!aborted) range.onDataRange(begin, bytes);
      })
      .catch((error) => {
        if (!aborted) onError(error);
      });
  };
  // PDF.js also calls this when the document is destroyed.
  range.abort = () => {
    aborted = true;
  };
  return {
    // Without both switches PDF.js fetches the rest of the file, although a
    // cover needs only the first page.
    source: {
      range,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      disableStream: true,
      disableAutoFetch: true,
    },
    abort: () => range.abort(),
  };
}

async function readRange(
  path: string,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  const bytes = await IOUtils.read(path, {
    offset: begin,
    maxBytes: end - begin,
  });
  if (bytes.length !== end - begin)
    throw new Error("PDF file changed while reading");
  return bytes;
}

async function renderFirstPage(
  win: Window,
  document: PDFDocument,
  targetWidth?: number,
): Promise<string> {
  const page = await document.getPage(1);
  const bounds = page.getViewport({ scale: 1 });
  const scale = Math.min(
    coverScale(bounds.width, bounds.height, targetWidth),
    Math.sqrt(MAX_CANVAS_PIXELS / (bounds.width * bounds.height)),
  );
  const viewport = page.getViewport({ scale });
  const canvas = win.document.createElement("canvas");
  canvas.width = Math.ceil(Math.min(viewport.width, MAX_CANVAS_EDGE));
  canvas.height = Math.ceil(Math.min(viewport.height, MAX_CANVAS_EDGE));
  const context = canvas.getContext("2d", {
    alpha: false,
  }) as CanvasRenderingContext2D | null;
  if (!context) throw new Error("Cannot create PDF cover canvas");
  await page.render({
    canvasContext: context,
    viewport,
    annotationMode: PDFJS_ANNOTATION_MODE_ENABLE,
  }).promise;
  return canvas.toDataURL("image/png");
}

function coverScale(
  width: number,
  height: number,
  targetWidth?: number,
): number {
  const edge = Math.max(width, height);
  return Math.min(
    targetWidth === undefined ? DEFAULT_COVER_EDGE / edge : targetWidth / width,
    MAX_CANVAS_EDGE / edge,
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Cannot encode PDF cover without a Zotero window");
  return win.btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Cannot decode PDF cover without a Zotero window");
  const binary = win.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isPNG(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((byte, index) => bytes[index] === byte);
}
