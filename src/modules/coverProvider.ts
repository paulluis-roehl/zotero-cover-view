export class CoverProvider {
  private static cache = new Map<number, string | null>();

  static async getCover(_itemID: number): Promise<string> {
    return `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;
  }

  static async findCover(_item: Zotero.Item): Promise<string | null> {
    return null;
  }

  static async createThumbnail(_source: string): Promise<string | null> {
    return null;
  }

  static clearCache(): void {
    this.cache.clear();
  }
}
