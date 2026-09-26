import { scheduleOpenLibraryRequest } from "../openLibraryRequestScheduler";

const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVERS_URL = "https://covers.openlibrary.org/b/olid";
const CACHE_MISS_TTL = 7 * 24 * 60 * 60 * 1000;

type Request = typeof scheduleOpenLibraryRequest;

const inFlight = new Map<string, Promise<string | null>>();

const cacheDirectory = (): string =>
  PathUtils.join(
    Zotero.DataDirectory.dir,
    "coverview",
    "covers",
    "open-library",
    "olid",
  );

const imagePath = (key: string): string =>
  PathUtils.join(cacheDirectory(), `${key}.jpg`);

const missingPath = (key: string): string =>
  PathUtils.join(cacheDirectory(), `${key}.missing`);

/** Find the first Open Library search result's cover edition and cache its JPEG. */
export function findMetadataCoverURI(
  title: string,
  author: string,
  request: Request = scheduleOpenLibraryRequest,
): Promise<string | null> {
  const normalizedTitle = title.trim();
  const normalizedAuthor = author.trim();
  if (!normalizedTitle || !normalizedAuthor) return Promise.resolve(null);

  const url = `${OPEN_LIBRARY_SEARCH_URL}?q=title:${encodeURIComponent(normalizedTitle)}%20author:${encodeURIComponent(normalizedAuthor)}`;
  const existing = inFlight.get(url);
  if (existing) return existing;

  const promise = findAndCacheCover(url, request).finally(() =>
    inFlight.delete(url),
  );
  inFlight.set(url, promise);
  return promise;
}

async function findAndCacheCover(
  url: string,
  request: Request,
): Promise<string | null> {
  const search = await request(url);
  if (search.status === 404) return null;
  if (search.status !== 200)
    throw new Error("Invalid Open Library search response");

  const result: unknown = JSON.parse(new TextDecoder().decode(search.bytes));
  const first =
    isRecord(result) && Array.isArray(result.docs) ? result.docs[0] : null;
  const key = isRecord(first) ? first.cover_edition_key : null;
  if (typeof key !== "string" || !/^OL\d+M$/.test(key)) return null;

  const cached = await readCachedCover(key);
  if (cached) return cached;
  if (await hasFreshMissingMarker(key)) return null;

  const response = await request(
    `${OPEN_LIBRARY_COVERS_URL}/${key}-L.jpg?default=false`,
  );
  if (response.status === 404) {
    await writeMissingMarker(key);
    return null;
  }
  if (response.status !== 200 || !isJPEG(response.bytes)) {
    throw new Error(`Invalid Open Library cover response for edition ${key}`);
  }

  await IOUtils.makeDirectory(cacheDirectory(), { createAncestors: true });
  const path = imagePath(key);
  await IOUtils.write(path, response.bytes, { tmpPath: `${path}.tmp` });
  await IOUtils.remove(missingPath(key), { ignoreAbsent: true });
  return Zotero.File.pathToFileURI(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCachedCover(key: string): Promise<string | null> {
  const path = imagePath(key);
  try {
    const bytes = await IOUtils.read(path);
    if (isJPEG(bytes)) return Zotero.File.pathToFileURI(path);
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    // Missing cache entries are normal on the first lookup.
  }
  return null;
}

async function hasFreshMissingMarker(key: string): Promise<boolean> {
  const path = missingPath(key);
  try {
    const timestamp = Number(await IOUtils.readUTF8(path));
    if (Number.isFinite(timestamp) && Date.now() - timestamp < CACHE_MISS_TTL) {
      return true;
    }
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    // No missing marker is the normal first-lookup path.
  }
  return false;
}

async function writeMissingMarker(key: string): Promise<void> {
  await IOUtils.makeDirectory(cacheDirectory(), { createAncestors: true });
  const path = missingPath(key);
  await IOUtils.writeUTF8(path, String(Date.now()), {
    tmpPath: `${path}.tmp`,
  });
}

function isJPEG(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
