const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const PACKAGE_NS = "http://www.idpf.org/2007/opf";
const PARSER_ERROR_NS = "http://www.mozilla.org/newlayout/xml/parsererror.xml";

export function isEPUBAttachment(item: Zotero.Item): boolean {
  return (
    item.isFileAttachment() &&
    (item.attachmentContentType === "application/epub+zip" ||
      item.attachmentReaderType === "epub")
  );
}

/**
 * Discover the declared EPUB 2/3 cover as a jar: URI, without extracting it.
 * Returns null when no cover is declared; malformed XML, invalid paths and
 * archive read failures throw so the caller can log and try another attachment.
 */
export async function findEPUBCoverURI(
  filePath: string,
  readText: (uri: string) => Promise<string> = readURIText,
): Promise<string | null> {
  const archiveURI = Zotero.File.pathToFileURI(filePath);
  const container = await readArchiveXML(
    archiveURI,
    "META-INF/container.xml",
    readText,
  );
  const rootfiles = children(
    container.documentElement,
    CONTAINER_NS,
    "rootfiles",
  )[0];
  const rootfile =
    rootfiles &&
    children(rootfiles, CONTAINER_NS, "rootfile").find(
      (entry) =>
        entry.getAttribute("media-type") === "application/oebps-package+xml",
    );
  const packagePath = rootfile?.getAttribute("full-path");
  if (!packagePath) return null;

  // container.xml full-path is a literal archive path, not a URL reference.
  if (packagePath.startsWith("/")) {
    throw new Error("EPUB package path must be relative to the archive root");
  }
  const normalizedPackagePath = normalizeArchivePath(packagePath.split("/"));
  const packageDocument = await readArchiveXML(
    archiveURI,
    normalizedPackagePath,
    readText,
  );
  const href = findCoverHref(packageDocument);
  if (!href) return null;

  return getArchiveEntryURI(
    archiveURI,
    resolveManifestHref(normalizedPackagePath, href),
  );
}

function children(
  parent: Element | null,
  namespace: string,
  name: string,
): Element[] {
  if (!parent) return [];
  return Array.from(parent.children).filter(
    (child) => child.namespaceURI === namespace && child.localName === name,
  );
}

function findCoverHref(document: Document): string | null {
  const root = document.documentElement;
  const manifest = children(root, PACKAGE_NS, "manifest")[0];
  if (!manifest) return null;
  const items = children(manifest, PACKAGE_NS, "item");
  const coverImage = items.find((item) =>
    item.getAttribute("properties")?.split(/\s+/).includes("cover-image"),
  );
  const href = coverImage?.getAttribute("href");
  if (href) return href;

  const metadata = children(root, PACKAGE_NS, "metadata")[0];
  if (!metadata) return null;
  const coverID = children(metadata, PACKAGE_NS, "meta")
    .find((entry) => entry.getAttribute("name")?.toLowerCase() === "cover")
    ?.getAttribute("content");
  if (!coverID) return null;
  return (
    items
      .find((item) => item.getAttribute("id") === coverID)
      ?.getAttribute("href") ?? null
  );
}

async function readArchiveXML(
  archiveURI: string,
  entryPath: string,
  readText: (uri: string) => Promise<string>,
): Promise<Document> {
  const text = await readText(getArchiveEntryURI(archiveURI, entryPath));
  // The plugin's bootstrap script context need not expose browser DOM globals.
  const Parser = ztoolkit.getGlobal("DOMParser") as typeof DOMParser;
  const document = new Parser().parseFromString(text, "application/xml");
  if (document.getElementsByTagNameNS(PARSER_ERROR_NS, "parsererror").length) {
    throw new Error(`Invalid EPUB XML: ${entryPath}`);
  }
  return document;
}

export function readURIText(uri: string): Promise<string> {
  const { NetUtil } = ChromeUtils.importESModule(
    "resource://gre/modules/NetUtil.sys.mjs",
  );
  const channel = NetUtil.newChannel({
    uri: Services.io.newURI(uri),
    loadUsingSystemPrincipal: true,
  });

  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream: nsIInputStream, status: nsresult) => {
      if (!Components.isSuccessCode(status)) {
        reject(Components.Exception(`Failed to read ${uri}`, status));
        return;
      }
      try {
        resolve(
          NetUtil.readInputStreamToString(stream, stream.available(), {
            charset: "UTF-8",
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getArchiveEntryURI(archiveURI: string, entryPath: string): string {
  const encodedPath = entryPath.split("/").map(encodeURIComponent).join("/");
  return `jar:${archiveURI}!/${encodedPath}`;
}

function resolveManifestHref(packagePath: string, href: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
    throw new Error(`External EPUB cover reference is unsupported: ${href}`);
  }
  const path = href.split(/[?#]/, 1)[0];
  if (!path) throw new Error("EPUB cover reference has no image path");

  // Decode each segment once; encoded separators must not change path structure.
  const segments = path
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  const base = path.startsWith("/") ? [] : packagePath.split("/").slice(0, -1);
  return normalizeArchivePath([...base, ...segments]);
}

function normalizeArchivePath(segments: string[]): string {
  const result: string[] = [];
  for (const segment of segments) {
    if (
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new Error("Invalid separator in EPUB archive path");
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!result.length) throw new Error("EPUB path escapes the archive root");
      result.pop();
    } else {
      result.push(segment);
    }
  }
  if (!result.length) throw new Error("Empty EPUB archive path");
  return result.join("/");
}
