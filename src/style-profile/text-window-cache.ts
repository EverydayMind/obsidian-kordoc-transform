import { Guard, StyleError } from './limits';

/** A copied fragment prevents a short cached slice retaining the entire source string. */
export type TextWindow = { ref: string; start: number; total: number; text: string; points: number };
const WINDOW_POINTS = 65_536;

export async function makeTextWindow(ref: string, text: string, total: number, start: number, startUnit: number, guard: Guard): Promise<TextWindow> {
  const end = Math.min(total, start + WINDOW_POINTS);
  let unit = startUnit, point = start;
  while (point < end && unit < text.length) {
    if ((point & 2047) === 0) await guard.tick();
    const cp = text.codePointAt(unit)!;
    unit += cp > 0xffff ? 2 : 1;
    point++;
  }
  guard.check();
  if (point !== end) throw new StyleError('corrupted', 'Text length differs from measurement.');
  const copied = Buffer.from(text.slice(startUnit, unit), 'utf16le').toString('utf16le');
  return { ref, start, total, text: copied, points: end - start };
}

export async function readTextWindow(window: TextWindow, offset: number, limit: number, guard: Guard): Promise<string | undefined> {
  const end = Math.min(offset + limit, window.total);
  if (offset > window.total || offset < window.start || end > window.start + window.points) return undefined;
  let point = window.start, unit = 0, startUnit = 0;
  while (point < end && unit < window.text.length) {
    if ((point & 2047) === 0) await guard.tick();
    if (point === offset) startUnit = unit;
    const cp = window.text.codePointAt(unit)!;
    unit += cp > 0xffff ? 2 : 1;
    point++;
  }
  if (offset === end) startUnit = unit;
  guard.check();
  if (point !== end) throw new StyleError('corrupted', 'Cached text length differs from measurement.');
  return window.text.slice(startUnit, unit);
}
