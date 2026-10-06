/** Renderer presentation tests need real, visible layout for on-demand tiles. */
const hosts = new Set<HTMLElement>();

afterEach(function () {
  for (const host of hosts) host.remove();
  hosts.clear();
});

export function createRendererHost(): HTMLElement {
  const doc = Zotero.getMainWindow()!.document;
  const host = doc.createElement("div");
  host.style.cssText =
    "display:grid;grid-template-columns:repeat(3,180px);width:600px;height:600px;overflow:auto;align-content:start;--cover-view-tile-size:180px";
  doc.documentElement.append(host);
  hosts.add(host);
  return host;
}
