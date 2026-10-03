export interface TagIndicator {
  tag: string;
  color: string | null;
  emoji: string | null;
}

/** Use Zotero's own library-specific ordering and emoji extraction. */
export function getTagIndicators(item: Zotero.Item): TagIndicator[] {
  // These native APIs are not yet declared by zotero-types.
  const nativeItem = item as Zotero.Item & {
    getItemsListTags?: () => { tag: string; color: string | null }[];
  };
  const tags = Zotero.Tags as typeof Zotero.Tags & {
    extractEmojiForItemsList: (tag: string) => string | null;
  };
  return (nativeItem.getItemsListTags?.() ?? []).map(({ tag, color }) => ({
    tag,
    color,
    emoji: tags.extractEmojiForItemsList(tag),
  }));
}
