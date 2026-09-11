const DEFAULT_COVER_WIDTH = 300;
const DEFAULT_PAGE_WIDTH = 612;

interface PDFRenderResult {
  buf: ArrayBuffer | null;
}

interface ZoteroPDFWorker {
  _enqueue<T>(action: () => Promise<T>, isPriority?: boolean): Promise<T>;
  _query<T>(
    action: string,
    data: Record<string, unknown>,
    transfer: ArrayBuffer[],
  ): Promise<T>;
}

/**
 * Render the first page of a PDF as a PNG data URI.
 */
export async function findPDFCoverURI(
  filePath: string,
  targetWidth = DEFAULT_COVER_WIDTH,
): Promise<string | null> {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) {
    throw new Error("PDF cover width must be a positive number");
  }

  const bytes = new Uint8Array(await IOUtils.read(filePath));
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const worker = Zotero.PDFWorker as ZoteroPDFWorker;
  const result = await worker._enqueue(() =>
    worker._query<PDFRenderResult>(
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
  if (!result.buf) return null;

  return `data:image/png;base64,${encodeBase64(result.buf)}`;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
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
