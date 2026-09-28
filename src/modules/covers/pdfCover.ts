const DEFAULT_COVER_WIDTH = 300;
const DEFAULT_PAGE_WIDTH = 612;
const MAX_CANVAS_PIXELS = 16_777_216;
const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const PDFJS_WASM_URL = "resource://zotero/reader/pdf/web/wasm/";

interface PDFPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

interface PDFJSModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: { data: Uint8Array; wasmUrl: string }): {
    promise: Promise<{
      getPage(index: number): Promise<PDFPage>;
      destroy(): Promise<void>;
    }>;
  };
}

interface ZoteroPDFWorker {
  _enqueue<T>(action: () => Promise<T>): Promise<T>;
  _query<T>(
    action: string,
    data: Record<string, unknown>,
    transfer: ArrayBuffer[],
  ): Promise<T>;
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

export function createPDFCacheSignature(
  attachment: Zotero.Item,
  filePath: string,
): string {
  return `v2:${attachment.id}:${attachment.dateModified ?? ""}:${filePath}`;
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
 */
export async function findPDFCoverURI(
  filePath: string,
  targetWidth = DEFAULT_COVER_WIDTH,
): Promise<string | null> {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) {
    throw new Error("PDF cover width must be a positive number");
  }

  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Cannot render PDF cover without a Zotero window");
  // Import in the window realm: Zotero's sandbox freezes Map.prototype, while
  // the reader's PDF.js module installs a Map polyfill during initialization.
  let pdfjs: PDFJSModule;
  try {
    pdfjs = (await win.eval(`import("${PDFJS_MODULE_URL}")`)) as PDFJSModule;
  } catch {
    // Older Zotero versions do not ship the reader as an ES module.
    return renderWithDocumentWorker(filePath, targetWidth);
  }
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const document = await pdfjs.getDocument({
    data: new Uint8Array(await IOUtils.read(filePath)),
    wasmUrl: PDFJS_WASM_URL,
  }).promise;
  try {
    const page = await document.getPage(1);
    const bounds = page.getViewport({ scale: 1 });
    const scale = Math.min(
      targetWidth / DEFAULT_PAGE_WIDTH,
      Math.sqrt(MAX_CANVAS_PIXELS / (bounds.width * bounds.height)),
    );
    const viewport = page.getViewport({ scale });
    const canvas = win.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", {
      alpha: false,
    }) as CanvasRenderingContext2D | null;
    if (!context) throw new Error("Cannot create PDF cover canvas");
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await document.destroy();
  }
}

async function renderWithDocumentWorker(
  filePath: string,
  targetWidth: number,
): Promise<string | null> {
  const bytes = new Uint8Array(await IOUtils.read(filePath));
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const worker = Zotero.PDFWorker as ZoteroPDFWorker;
  const result = await worker._enqueue(() =>
    worker._query<{ buf: ArrayBuffer | null }>(
      "pdf.renderArea",
      {
        buf,
        pageIndex: 0,
        rect: [-1e7, -1e7, 1e7, 1e7],
        scale: targetWidth / DEFAULT_PAGE_WIDTH,
      },
      [buf],
    ),
  );
  return result.buf ? `${PNG_DATA_PREFIX}${encodeBase64(result.buf)}` : null;
}

function encodeBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
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
