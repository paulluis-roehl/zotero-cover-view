import { scheduleOpenLibraryRequest } from "../openLibraryRequestScheduler";

const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVERS_URL = "https://covers.openlibrary.org/b/olid";
const CACHE_MISS_TTL = 7 * 24 * 60 * 60 * 1000;
const SEARCH_RESULT_TTL = 30 * 24 * 60 * 60 * 1000;
export const MAX_SEARCH_RESULTS = 5;

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

const searchPath = (query: string): string =>
  PathUtils.join(
    cacheDirectory(),
    "search",
    `${Zotero.Utilities.Internal.sha1(query)}.json`,
  );

/** Find the first cover edition within the search-result limit and cache its JPEG. */
export function findMetadataCoverURI(
  title: string,
  author: string,
  request: Request = scheduleOpenLibraryRequest,
): Promise<string | null> {
  const normalizedTitle = title.trim();
  const normalizedAuthor = author.trim();
  if (!normalizedTitle || !normalizedAuthor) return Promise.resolve(null);

  // The tuple, not the request URL, is the identity of a metadata lookup.
  const query = JSON.stringify([normalizedTitle, normalizedAuthor]);
  const existing = inFlight.get(query);
  if (existing) return existing;

  const url = `${OPEN_LIBRARY_SEARCH_URL}?q=title:${encodeURIComponent(normalizedTitle)}%20author:${encodeURIComponent(normalizedAuthor)}`;
  const promise = findAndCacheCover(query, url, request).finally(() =>
    inFlight.delete(query),
  );
  inFlight.set(query, promise);
  return promise;
}

async function findAndCacheCover(
  query: string,
  url: string,
  request: Request,
): Promise<string | null> {
  const cachedSearch = await readCachedSearch(query);
  const key =
    cachedSearch !== undefined
      ? cachedSearch
      : await searchForEdition(query, url, request);
  if (!key) return null;

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

async function searchForEdition(
  query: string,
  url: string,
  request: Request,
): Promise<string | null> {
  const search = await request(url);
  if (search.status === 404) {
    await writeCachedSearch(query, null);
    return null;
  }
  if (search.status !== 200)
    throw new Error("Invalid Open Library search response");

  const result: unknown = JSON.parse(new TextDecoder().decode(search.bytes));
  let key: string | null = null;
  if (isRecord(result) && Array.isArray(result.docs)) {
    for (const entry of result.docs.slice(0, MAX_SEARCH_RESULTS)) {
      const candidate = isRecord(entry) ? entry.cover_edition_key : null;
      if (typeof candidate === "string" && /^OL\d+M$/.test(candidate)) {
        key = candidate;
        break;
      }
    }
  }
  await writeCachedSearch(query, key);
  return key;
}

async function readCachedSearch(
  query: string,
): Promise<string | null | undefined> {
  try {
    const value: unknown = JSON.parse(
      await IOUtils.readUTF8(searchPath(query)),
    );
    if (!isRecord(value) || value.query !== query) return undefined;
    if (
      value.key !== null &&
      (typeof value.key !== "string" || !/^OL\d+M$/.test(value.key))
    )
      return undefined;
    const ttl = value.key === null ? CACHE_MISS_TTL : SEARCH_RESULT_TTL;
    if (
      typeof value.timestamp !== "number" ||
      value.timestamp > Date.now() ||
      Date.now() - value.timestamp >= ttl
    ) {
      await IOUtils.remove(searchPath(query), { ignoreAbsent: true });
      return undefined;
    }
    return value.key;
  } catch {
    // Missing or malformed search cache entries are treated as cache misses.
    return undefined;
  }
}

async function writeCachedSearch(
  query: string,
  key: string | null,
): Promise<void> {
  const path = searchPath(query);
  await IOUtils.makeDirectory(PathUtils.join(cacheDirectory(), "search"), {
    createAncestors: true,
  });
  await IOUtils.writeUTF8(
    path,
    JSON.stringify({ query, key, timestamp: Date.now() }),
    {
      tmpPath: `${path}.tmp`,
    },
  );
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
