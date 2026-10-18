/** Real image bytes for provider-backed cover tests, without network lookup. */
export function coverImageFixture(
  width: number,
  height: number,
  type = "image/png",
): Uint8Array {
  const win = Zotero.getMainWindow()!;
  const canvas = win.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  (canvas.getContext("2d")! as CanvasRenderingContext2D).fillRect(
    0,
    0,
    width,
    height,
  );
  return Uint8Array.from(win.atob(canvas.toDataURL(type).split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
}
