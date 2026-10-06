/** Geometry in scroll-content coordinates, independent of mounted tiles. */
export interface GridRowGeometry {
  top: number;
  height: number;
}

export function getPageRow(
  rows: readonly GridRowGeometry[],
  currentRow: number,
  direction: -1 | 1,
  viewportTop: number,
  viewportBottom: number,
): number {
  const currentTop = rows[currentRow].top;
  const rowStep = rows.length > 1 ? rows[1].top - rows[0].top : 0;
  const distance = Math.max(rowStep, viewportBottom - viewportTop - 1);
  const edge = direction === 1 ? viewportBottom - 1 : viewportTop;
  const targetTop =
    direction === 1
      ? Math.max(currentTop + rowStep, Math.min(currentTop + distance, edge))
      : Math.min(currentTop - rowStep, Math.max(currentTop - distance, edge));

  let destination = currentRow;
  for (
    let index = currentRow + direction;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    destination = index;
    if (direction * (rows[index].top - targetTop) > 1e-4) {
      const previous = index - direction;
      const partiallyVisible =
        direction === 1
          ? rows[index].top < viewportBottom - 1e-4
          : rows[index].top + rows[index].height > viewportTop + 1e-4;
      if (previous !== currentRow && !partiallyVisible) destination = previous;
      break;
    }
  }
  return destination;
}
