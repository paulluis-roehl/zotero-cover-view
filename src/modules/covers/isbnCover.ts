const OPEN_LIBRARY_COVERS_URL = "https://covers.openlibrary.org/b/isbn";
const CACHE_MISS_TTL = 7 * 24 * 60 * 60 * 1000;

interface CoverResponse {
  status: number;
  bytes: Uint8Array;
}

type RequestCover = (url: string) => Promise<CoverResponse>;

const inFlight = new Map<string, Promise<string | null>>();

const cacheDirectory = (): string =>
  PathUtils.join(
    Zotero.DataDirectory.dir,
    "coverview",
    "covers",
    "open-library",
  );

const imagePath = (isbn: string): string =>
  PathUtils.join(cacheDirectory(), `${isbn}.jpg`);

const missingPath = (isbn: string): string =>
  PathUtils.join(cacheDirectory(), `${isbn}.missing`);

export function extractISBNs(value: string): string[] {
  const isbns: string[] = [];
  const seen = new Set<string>();
  for (const identifier of Zotero.Utilities.extractIdentifiers(value)) {
    if (!("ISBN" in identifier)) continue;

    const isbn = normalizeISBN(identifier.ISBN);
    if (isbn && !seen.has(isbn)) {
      seen.add(isbn);
      isbns.push(isbn);
    }
  }
  return isbns;
}

/**
 * Find an Open Library cover by ISBN and cache it in the Zotero data directory.
 */
export function findISBNCoverURI(
  isbn: string,
  requestCover: RequestCover = requestOpenLibraryCover,
): Promise<string | null> {
  const normalizedISBN = normalizeISBN(isbn);
  if (!normalizedISBN) return Promise.resolve(null);

  const existing = inFlight.get(normalizedISBN);
  if (existing) return existing;

  const promise = findAndCacheCover(normalizedISBN, requestCover).finally(() =>
    inFlight.delete(normalizedISBN),
  );
  inFlight.set(normalizedISBN, promise);
  return promise;
}

async function findAndCacheCover(
  isbn: string,
  requestCover: RequestCover,
): Promise<string | null> {
  const cached = await readCachedCover(isbn);
  if (cached) return cached;
  if (await hasFreshMissingMarker(isbn)) return null;

  const url = `${OPEN_LIBRARY_COVERS_URL}/${encodeURIComponent(isbn)}-L.jpg?default=false`;
  const response = await requestCover(url);
  if (response.status === 404) {
    await writeMissingMarker(isbn);
    return null;
  }
  if (response.status !== 200 || !isJPEG(response.bytes)) {
    throw new Error(`Invalid Open Library cover response for ISBN ${isbn}`);
  }

  await IOUtils.makeDirectory(cacheDirectory(), { createAncestors: true });
  const path = imagePath(isbn);
  await IOUtils.write(path, response.bytes, { tmpPath: `${path}.tmp` });
  await IOUtils.remove(missingPath(isbn), { ignoreAbsent: true });
  return Zotero.File.pathToFileURI(path);
}

async function requestOpenLibraryCover(url: string): Promise<CoverResponse> {
  const response = await Zotero.HTTP.request("GET", url, {
    headers: { Accept: "image/jpeg" },
    responseType: "arraybuffer",
    successCodes: [200, 404],
    timeout: 15_000,
    errorDelayMax: 0,
  });
  return {
    status: response.status,
    bytes: new Uint8Array(response.response as ArrayBuffer),
  };
}

async function readCachedCover(isbn: string): Promise<string | null> {
  const path = imagePath(isbn);
  try {
    const bytes = await IOUtils.read(path);
    if (isJPEG(bytes)) return Zotero.File.pathToFileURI(path);
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    // A missing cache entry is the normal first-lookup path.
  }
  return null;
}

async function hasFreshMissingMarker(isbn: string): Promise<boolean> {
  const path = missingPath(isbn);
  try {
    const timestamp = Number(await IOUtils.readUTF8(path));
    if (Number.isFinite(timestamp) && Date.now() - timestamp < CACHE_MISS_TTL) {
      return true;
    }
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    // A missing marker is the normal path when a cover has not been checked.
  }
  return false;
}

async function writeMissingMarker(isbn: string): Promise<void> {
  await IOUtils.makeDirectory(cacheDirectory(), { createAncestors: true });
  const path = missingPath(isbn);
  await IOUtils.writeUTF8(path, String(Date.now()), {
    tmpPath: `${path}.tmp`,
  });
}

function normalizeISBN(value: string): string | null {
  const isbn = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) return isValidISBN10(isbn) ? isbn : null;
  if (/^\d{13}$/.test(isbn)) return isValidISBN13(isbn) ? isbn : null;
  return null;
}

function isValidISBN10(isbn: string): boolean {
  let sum = 0;
  for (let index = 0; index < isbn.length; index++) {
    const digit = isbn[index] === "X" ? 10 : Number(isbn[index]);
    sum += digit * (10 - index);
  }
  return sum % 11 === 0;
}

function isValidISBN13(isbn: string): boolean {
  let sum = 0;
  for (let index = 0; index < isbn.length; index++) {
    sum += Number(isbn[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

function isJPEG(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
