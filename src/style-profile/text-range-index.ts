import { Guard, StyleError } from './limits';

/** UTF-16 offsets at fixed code-point intervals. Published only when complete. */
export const RANGE_INDEX_STRIDE = 1024;
/** Conservative reservation for arrays, buffers and map entries. */
export function textRangeIndexReservation(totals: Iterable<number>): number {
  let bytes = 0;
  for (const total of totals) if (total >= RANGE_INDEX_STRIDE) bytes += 64 + 4 * (Math.floor(total / RANGE_INDEX_STRIDE) + 1);
  return bytes;
}
/** A rejected reservation leaves the caller's text-only cache budget intact. */
export function planTextRangeIndex(textBytes: number, totals: Iterable<number>, maxBytes: number): number | undefined {
  const bytes = textRangeIndexReservation(totals);
  return textBytes > 0 && textBytes + bytes <= maxBytes ? bytes : undefined;
}
export async function buildTextRangeIndex(text: string, total: number, guard: Guard): Promise<Uint32Array> {
  const positions = new Uint32Array(Math.floor(total / RANGE_INDEX_STRIDE) + 1);
  let unit = 0, points = 0;
  while (unit < text.length) {
    if ((points & 2047) === 0) await guard.tick();
    if (points % RANGE_INDEX_STRIDE === 0) positions[points / RANGE_INDEX_STRIDE] = unit;
    const cp = text.codePointAt(unit)!;
    unit += cp > 0xffff ? 2 : 1;
    points++;
  }
  guard.check();
  if (points !== total) throw new StyleError('corrupted', 'Text length differs from measurement.');
  if (points % RANGE_INDEX_STRIDE === 0) positions[points / RANGE_INDEX_STRIDE] = unit;
  return positions;
}
