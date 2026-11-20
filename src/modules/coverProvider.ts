import { getPref, observePrefs } from "../utils/prefs";
import { findEPUBCoverURI, isEPUBAttachment } from "./covers/epubCover";
import { findImgCoverURI, isImgAttachment } from "./covers/imgCover";
import { extractISBNs, findISBNCoverURI } from "./covers/isbnCover";
import { findMetadataCoverURI } from "./covers/metadataCover";
import { createPlaceholderCoverURI } from "./covers/placeholderCover";
import {
  cachePDFCover,
  createPDFCacheSignature,
  deleteCachedPDFCover,
  findPDFCoverURI,
  getCachedPDFCover,
  isPDFAttachment,
} from "./covers/pdfCover";

export interface CoverResult {
  uri: string;
  source: "attachment" | "online" | "placeholder";
}

export class CoverProvider {
  private static cache = new Map<
    number,
    {
      generation: number;
      fetchISBNCover: boolean;
      fetchMetadataCover: boolean;
      metadata: string;
      promise: Promise<CoverResult | null>;
      uriPromise: Promise<string | null>;
      result?: CoverResult | null;
      /** Candidates passed over because their file was missing. */
      missingFileAttachments: Zotero.Item[];
    }
  >();
  private static dimensions = new Map<
    string,
    { width: number; height: number }
  >();
  private static generations = new Map<number, number>();
  private static attachmentParents = new Map<number, number>();
  private static attachmentSignatures = new Map<number, string>();
  private static notifierID: string | undefined;
  private static listeners = new Set<(itemID: number) => void>();
  private static refreshListeners = new Set<() => void>();
  private static stopObservingPreferences: (() => void) | undefined;

  static onCoverChanged(listener: (itemID: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Request that consumers re-resolve covers after lookup settings change. */
  static onCoversRefreshRequested(listener: () => void): () => void {
    this.refreshListeners.add(listener);
    return () => this.refreshListeners.delete(listener);
  }

  static cacheCover(item: Zotero.Item): void {
    const fetchISBNCover = this.shouldFetchISBNCover();
    const fetchMetadataCover = this.shouldFetchMetadataCover();
    const cached = this.cache.get(item.id);
    const metadata = this.metadataSignature(item);
    if (
      cached?.fetchISBNCover !== fetchISBNCover ||
      cached?.fetchMetadataCover !== fetchMetadataCover ||
      cached?.metadata !== metadata
    ) {
      if (cached) {
        this.generations.set(item.id, this.currentGeneration(item.id) + 1);
      }
      const generation = this.currentGeneration(item.id);
      const missingFileAttachments: Zotero.Item[] = [];
      const cover = this.findCoverResult(
        item,
        undefined,
        undefined,
        undefined,
        undefined,
        generation,
        fetchISBNCover,
        undefined,
        fetchMetadataCover,
        missingFileAttachments,
      )
        .catch((error) => {
          ztoolkit.log("Failed to resolve cover", item.id, error);
          return null;
        })
        .then(async (value) => {
          const dimensions =
            value && value.source !== "placeholder"
              ? await this.readCoverDimensions(value.uri)
              : undefined;
          const result =
            this.currentGeneration(item.id) === generation ? value : null;
          const entry = this.cache.get(item.id);
          if (entry?.promise === cover) {
            if (result && dimensions)
              this.dimensions.set(result.uri, dimensions);
            entry.result = result;
          }
          return result;
        });
      this.cache.set(item.id, {
        generation,
        fetchISBNCover,
        fetchMetadataCover,
        metadata,
        promise: cover,
        uriPromise: cover.then((result) => result?.uri ?? null),
        missingFileAttachments,
      });
      // Native row rendering may observe the edited item before its notifier
      // callback. Still refresh the grid when this happens first.
      if (cached && cached.metadata !== metadata)
        this.emitCoverChanged(item.id);
    }
  }

  static getCover(itemID: number): Promise<string | null> {
    return this.cache.get(itemID)?.uriPromise ?? Promise.resolve(null);
  }

  static getCoverResult(itemID: number): Promise<CoverResult | null> {
    return this.cache.get(itemID)?.promise ?? Promise.resolve(null);
  }

  /** Undefined means the current lookup has not resolved yet. */
  static getCachedCoverResult(itemID: number): CoverResult | null | undefined {
    return this.cache.get(itemID)?.result;
  }

  static getCoverDimensions(
    uri: string,
  ): { width: number; height: number } | undefined {
    return this.dimensions.get(uri);
  }

  /**
   * Look up the current cover again if an attachment file that was missing
   * during the lookup has since appeared, e.g. restored outside Zotero.
   */
  static async recheckMissingAttachmentFiles(item: Zotero.Item): Promise<void> {
    const entry = this.cache.get(item.id);
    if (
      !entry ||
      entry.result === undefined ||
      !entry.missingFileAttachments.length
    )
      return;
    for (const attachment of entry.missingFileAttachments) {
      let exists = false;
      try {
        exists = await attachment.fileExists();
      } catch (error) {
        ztoolkit.log("Failed to check attachment file", attachment.id, error);
      }
      if (!exists) continue;
      if (this.cache.get(item.id) !== entry) return;
      this.invalidate(item.id, { discardPDF: false });
      this.emitCoverChanged(item.id);
      return;
    }
  }

  private static async readCoverDimensions(
    uri: string,
  ): Promise<{ width: number; height: number } | undefined> {
    const win = Zotero.getMainWindow();
    if (!win) return;
    // Decode the source image off-DOM, independently of any consumer's CSS size.
    const image = new win.Image();
    image.src = uri;
    try {
      await image.decode();
      if (image.naturalWidth && image.naturalHeight)
        return { width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      // Keep dimension discovery best-effort, as cover lookup was before.
    }
    return undefined;
  }

  static shouldFetchISBNCover(): boolean {
    return getPref("fetchISBNCover");
  }

  static shouldFetchMetadataCover(): boolean {
    return getPref("fetchMetadataCover");
  }

  static async findCover(
    ...args: Parameters<typeof CoverProvider.findCoverResult>
  ): Promise<string | null> {
    return (await this.findCoverResult(...args))?.uri ?? null;
  }

  static async findCoverResult(
    item: Zotero.Item,
    findEPUBCover: typeof findEPUBCoverURI = findEPUBCoverURI,
    findPDFCover: typeof findPDFCoverURI = findPDFCoverURI,
    findImgCover: typeof findImgCoverURI = findImgCoverURI,
    findISBNCover: typeof findISBNCoverURI = findISBNCoverURI,
    generation = this.currentGeneration(item.id),
    fetchISBNCover = this.shouldFetchISBNCover(),
    findMetadataCover: typeof findMetadataCoverURI = findMetadataCoverURI,
    fetchMetadataCover = this.shouldFetchMetadataCover(),
    /** Receives the candidates passed over because their file is missing. */
    missingFileAttachments: Zotero.Item[] = [],
  ): Promise<CoverResult | null> {
    const signatures = this.savedAttachmentSignatures(item);
    const attachments = await this.findAttachments(item);
    // Remember the entire ranked list, including candidates after the winner,
    // so removal or reparenting can invalidate the former parent's choice.
    for (const attachment of attachments)
      this.rememberParent(attachment, item, signatures.get(attachment.id));
    for (const attachment of attachments) {
      try {
        if (!this.isSupportedAttachment(attachment)) continue;
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) {
          missingFileAttachments.push(attachment);
          continue;
        }
        // A URI (or a cached PDF cover) alone does not prove the candidate is
        // available. Probe readability without introducing image decoding.
        if (item.isRegularItem?.()) {
          await IOUtils.read(filePath, { maxBytes: 1 });
        }

        let cover: string | null;
        if (isImgAttachment(attachment)) {
          cover = await findImgCover(filePath);
        } else if (isEPUBAttachment(attachment)) {
          cover = await findEPUBCover(filePath);
        } else {
          const signature = await createPDFCacheSignature(attachment, filePath);
          const cached =
            findPDFCover === findPDFCoverURI
              ? await getCachedPDFCover(item.id, signature)
              : null;
          cover = cached ?? (await findPDFCover(filePath));
          if (
            cover &&
            findPDFCover === findPDFCoverURI &&
            !cached &&
            this.currentGeneration(item.id) === generation
          ) {
            await cachePDFCover(item.id, signature, cover);
          }
        }
        if (cover) return { uri: cover, source: "attachment" };
      } catch (error) {
        ztoolkit.log("Failed to find attachment cover", attachment.id, error);
      }
    }

    if (item.isRegularItem?.() && fetchISBNCover) {
      for (const isbn of extractISBNs(item.getField("ISBN"))) {
        try {
          const cover = await findISBNCover(isbn);
          if (cover) return { uri: cover, source: "online" };
        } catch (error) {
          ztoolkit.log("Failed to find ISBN cover", isbn, error);
        }
      }
    }

    if (
      fetchMetadataCover &&
      item.isRegularItem?.() &&
      item.itemType === "book"
    ) {
      const title = item.getField("title");
      const firstAuthor = item
        .getCreatorsJSON()
        .find((creator) => creator.creatorType === "author");
      const author =
        firstAuthor?.name?.trim() ||
        [firstAuthor?.lastName?.trim(), firstAuthor?.firstName?.trim()]
          .filter(Boolean)
          .join(", ");
      if (title?.trim() && author) {
        try {
          // Zotero also supports single-field creators (`name`), which have
          // no lastName. Use the final word as a surname for that form.
          const surname =
            firstAuthor?.lastName?.trim() ||
            firstAuthor?.name?.trim().split(/\s+/).at(-1);
          const authors =
            surname && surname !== author ? [author, surname] : [author];
          for (const queryAuthor of authors) {
            const cover = await findMetadataCover(title, queryAuthor);
            if (cover) return { uri: cover, source: "online" };
          }
        } catch (error) {
          ztoolkit.log("Failed to find metadata cover", item.id, error);
        }
      }
    }

    return { uri: createPlaceholderCoverURI(item), source: "placeholder" };
  }

  static clearCache(): void {
    this.cache.clear();
    this.dimensions.clear();
    this.generations.clear();
    this.attachmentParents.clear();
    this.attachmentSignatures.clear();
  }

  private static metadataSignature(item: Zotero.Item): string {
    return JSON.stringify([
      item.itemType,
      item.getDisplayTitle?.(),
      item.getField?.("title"),
      item.firstCreator,
      item.getCreatorsJSON?.(),
      item.getField?.("date"),
      item.getField?.("ISBN"),
      item.getField?.("url"),
    ]);
  }

  static registerNotifier(): void {
    if (this.notifierID) return;
    this.stopObservingPreferences ??= observePrefs(
      ["fetchISBNCover", "fetchMetadataCover"],
      () => {
        for (const listener of this.refreshListeners) listener();
      },
    );
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids, extraData) => {
          if (type === "file") {
            // Only a finished download can make an attachment file appear;
            // reader events such as page turns must not trigger lookups.
            if ((event as string) === "download") this.onFileDownloaded(ids);
            return;
          }
          // Redraws only repaint rows, e.g. the Cover column after a change.
          if (event === "redraw") return;
          for (const rawID of ids) {
            const id = Number(rawID);
            const attachment = Zotero.Items.get(id);
            // Zotero also saves attachments for reading (last-read time) and
            // annotating, without changing anything that affects a cover.
            const signature = this.attachmentSignatures.get(id);
            if (
              event === "modify" &&
              attachment &&
              signature !== undefined &&
              signature === this.attachmentSignature(attachment)
            )
              continue;
            this.attachmentSignatures.delete(id);
            if (
              event === "modify" &&
              attachment &&
              attachment.isRegularItem?.() &&
              !attachment.parentItemID
            ) {
              const cached = this.cache.get(id);
              if (
                cached &&
                cached.metadata !== this.metadataSignature(attachment)
              ) {
                this.invalidate(id, { discardPDF: false });
                this.emitCoverChanged(id);
              }
              continue;
            }
            const parentIDs = new Set<number>();
            const knownParent = this.attachmentParents.get(id);
            if (knownParent) parentIDs.add(knownParent);
            if (attachment && attachment.isFileAttachment()) {
              if (attachment.parentItemID) {
                parentIDs.add(attachment.parentItemID);
                this.attachmentParents.set(id, attachment.parentItemID);
              } else {
                this.attachmentParents.delete(id);
              }
            } else if (event === "delete") {
              this.attachmentParents.delete(id);
            }
            const data =
              extraData?.[rawID] ?? extraData?.[String(id)] ?? extraData;
            for (const key of [
              "oldParentItemID",
              "previousParentItemID",
              "oldParentID",
              "oldParent",
            ]) {
              if (data?.[key]) parentIDs.add(Number(data[key]));
            }
            for (const parentID of parentIDs) {
              this.invalidate(parentID);
              this.emitCoverChanged(parentID);
            }
          }
        },
      },
      ["item", "file"],
      "cover-view-covers",
    );
  }

  private static onFileDownloaded(ids: (number | string)[]): void {
    for (const rawID of ids) {
      const id = Number(rawID);
      const itemIDs = new Set<number>([id]);
      const knownParent = this.attachmentParents.get(id);
      if (knownParent) itemIDs.add(knownParent);
      const attachment = Zotero.Items.get(id);
      if (attachment && attachment.parentItemID)
        itemIDs.add(attachment.parentItemID);
      for (const itemID of itemIDs) {
        this.invalidate(itemID);
        this.emitCoverChanged(itemID);
      }
    }
  }

  static unregisterNotifier(): void {
    this.stopObservingPreferences?.();
    this.stopObservingPreferences = undefined;
    if (!this.notifierID) return;
    Zotero.Notifier.unregisterObserver(this.notifierID);
    this.notifierID = undefined;
  }

  static invalidate(
    itemID: number,
    { discardPDF = true }: { discardPDF?: boolean } = {},
  ): void {
    this.generations.set(itemID, (this.generations.get(itemID) ?? 0) + 1);
    this.cache.delete(itemID);
    if (discardPDF) void deleteCachedPDFCover(itemID);
  }

  private static emitCoverChanged(itemID: number): void {
    for (const listener of this.listeners) listener(itemID);
  }

  private static currentGeneration(itemID: number): number {
    return this.generations.get(itemID) ?? 0;
  }

  private static rememberParent(
    attachment: Zotero.Item,
    item: Zotero.Item,
    signature: string | undefined,
  ): void {
    if (attachment.id && item.isRegularItem?.()) {
      this.attachmentParents.set(attachment.id, item.id);
      if (signature === undefined)
        this.attachmentSignatures.delete(attachment.id);
      else this.attachmentSignatures.set(attachment.id, signature);
    }
  }

  /**
   * Signatures of the child attachments as ranked by a lookup starting now.
   * Unsaved changes are left out: the ranking may not reflect them yet.
   */
  private static savedAttachmentSignatures(
    item: Zotero.Item,
  ): Map<number, string> {
    const signatures = new Map<number, string>();
    if (!item.isRegularItem?.()) return signatures;
    for (const id of item.getAttachments(true)) {
      const attachment = Zotero.Items.get(id);
      if (attachment && !attachment.hasChanged())
        signatures.set(id, this.attachmentSignature(attachment));
    }
    return signatures;
  }

  /** What decides an attachment's ranking and the cover drawn from it. */
  private static attachmentSignature(attachment: Zotero.Item): string {
    return JSON.stringify([
      attachment.parentItemID,
      attachment.deleted,
      attachment.attachmentLinkMode,
      attachment.attachmentContentType,
      attachment.attachmentPath,
      attachment.getField?.("url"),
      attachment.dateAdded,
    ]);
  }

  private static isSupportedAttachment(item: Zotero.Item): boolean {
    return (
      isImgAttachment(item) || isEPUBAttachment(item) || isPDFAttachment(item)
    );
  }

  private static async findAttachments(
    item: Zotero.Item,
  ): Promise<Zotero.Item[]> {
    if (item.isFileAttachment()) {
      return [item];
    }
    if (!item.isRegularItem()) {
      return [];
    }
    return item.getBestAttachments();
  }
}
