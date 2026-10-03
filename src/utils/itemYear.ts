/** Match Zotero's native Year column, not arbitrary years in display text. */
export function getItemYear(item: Zotero.Item): string {
  const rawYear = String(item.getField?.("date", true, true) || "").slice(0, 4);
  return rawYear && rawYear !== "0000" ? String(Number(rawYear)) : "";
}
