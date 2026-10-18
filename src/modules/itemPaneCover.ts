import { CoverProvider, type CoverResult } from "./coverProvider";
import { getLocaleID, getString } from "../utils/locale";

type SectionProps = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;
interface SectionState {
  props?: SectionProps;
  generation: number;
  resize: () => void;
  stopSizing: () => void;
}

const sections = new Map<HTMLDivElement, SectionState>();
const localeLinks = new Map<Window, HTMLLinkElement>();
let paneID: string | undefined;
let stopCoverChanges: (() => void) | undefined;
let stopCoverRefresh: (() => void) | undefined;

export function attachItemPaneCoverWindow(win: Window): void {
  if (localeLinks.has(win)) return;
  const link = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.rel = "localization";
  link.href = `${addon.data.config.addonRef}-addon.ftl`;
  win.document.documentElement?.appendChild(link);
  localeLinks.set(win, link);
}

export function detachItemPaneCoverWindow(win: Window): void {
  localeLinks.get(win)?.remove();
  localeLinks.delete(win);
}

function updateCover(props: SectionProps): void {
  const state = sections.get(props.body);
  if (!state) return;
  state.props = props;
  const generation = ++state.generation;
  const { item, body, doc, setEnabled, tabType } = props;
  const image = body.querySelector<HTMLImageElement>("img")!;
  image.hidden = true;
  image.removeAttribute("src");
  image.style.removeProperty("width");
  image.style.removeProperty("height");
  const selected = (
    doc.defaultView as _ZoteroTypes.MainWindow
  ).ZoteroPane.getSelectedItems(true);
  const enabled =
    tabType === "library" &&
    !!item &&
    selected.length === 1 &&
    selected[0] === item.id;
  setEnabled(enabled);
  if (!enabled || !(item.isRegularItem() || item.isFileAttachment())) return;

  // Resolve even while collapsed: native async rendering is visibility-dependent.
  CoverProvider.cacheCover(item);
  const showCover = (cover: CoverResult | null) => {
    if (
      sections.get(body) !== state ||
      state.generation !== generation ||
      !body.isConnected
    )
      return;
    const win = doc.defaultView as _ZoteroTypes.MainWindow;
    const selected = win.ZoteroPane.getSelectedItems(true);
    if (selected.length !== 1 || selected[0] !== item.id) return;
    if (!cover || cover.source === "placeholder") return;
    image.alt = getString("cover-view-image-alt", {
      args: { title: item.getDisplayTitle() },
    });
    image.src = cover.uri;
    state.resize();
    image.hidden = false;
    setEnabled(true);
  };
  // Establish known cover geometry before ItemDetails restores its scroll.
  // Async rendering alone is too late, even for an already-resolved promise.
  const cached = CoverProvider.getCachedCoverResult(item.id);
  if (cached !== undefined) showCover(cached);
  else void CoverProvider.getCoverResult(item.id).then(showCover);
}

function refreshItemPaneCovers(): void {
  for (const state of sections.values()) {
    if (state.props) updateCover(state.props);
  }
}

export function registerItemPaneCover(): void {
  if (paneID) return;
  const icons = `chrome://${addon.data.config.addonRef}/content/icons`;
  const registered = Zotero.ItemPaneManager.registerSection({
    paneID: "cover",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("item-pane-cover"),
      icon: `${icons}/cover-section-16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-pane-cover"),
      icon: `${icons}/cover-section-20.svg`,
    },
    bodyXHTML: `<html:img class="cover-view-item-pane-image" draggable="false" hidden="hidden"
      style="margin: 0 auto; max-width: 100%; object-fit: contain;" />`,
    onInit: ({ body, doc }) => {
      body.style.display = "flex";
      body.style.flexDirection = "column";
      body.style.alignItems = "center";
      const win = doc.defaultView as _ZoteroTypes.MainWindow;
      const image = body.querySelector<HTMLImageElement>("img")!;
      const resize = () => {
        const dimensions = CoverProvider.getCoverDimensions(image.src);
        if (!dimensions) return;
        // Match Attachment Info's attachment-preview width/aspect/height rules.
        const ratio = dimensions.width / dimensions.height;
        const height = Math.min(
          body.clientWidth / ratio,
          Math.max(win.screen.availHeight - 200, 600),
        );
        image.style.width = `${height * ratio}px`;
        image.style.height = `${height}px`;
      };
      const observer = new win.ResizeObserver(resize);
      observer.observe(body);
      image.addEventListener("load", resize);
      sections.set(body, {
        generation: 0,
        resize,
        stopSizing: () => {
          observer.disconnect();
          image.removeEventListener("load", resize);
        },
      });
    },
    onItemChange: updateCover,
    onRender: () => {},
    onDestroy: ({ body }) => {
      sections.get(body)?.stopSizing();
      sections.delete(body);
    },
  });
  if (!registered) return;
  paneID = registered;
  // Zotero 7/8 persist section order in this comma-separated preference.
  // Insert only our new ID, retaining all existing (including other plugins') IDs.
  const order = ((Zotero.Prefs.get("sidenav.order") as string) || "info").split(
    ",",
  );
  if (!order.includes(paneID)) {
    const info = order.indexOf("info");
    order.splice(info < 0 ? 0 : info, 0, paneID);
    Zotero.Prefs.set("sidenav.order", order.join(","));
  }
  stopCoverChanges = CoverProvider.onCoverChanged((itemID) => {
    for (const state of sections.values()) {
      if (state.props?.item?.id === itemID) updateCover(state.props);
    }
  });
  stopCoverRefresh = CoverProvider.onCoversRefreshRequested(
    refreshItemPaneCovers,
  );
}

export function unregisterItemPaneCover(): void {
  stopCoverChanges?.();
  stopCoverChanges = undefined;
  stopCoverRefresh?.();
  stopCoverRefresh = undefined;
  for (const state of sections.values()) state.stopSizing();
  sections.clear();
  if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
  paneID = undefined;
  for (const win of localeLinks.keys()) detachItemPaneCoverWindow(win);
}
