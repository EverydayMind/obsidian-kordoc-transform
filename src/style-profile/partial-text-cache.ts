import { Guard } from './limits';

/** Keep the requested paragraph first, then as many others as fit the existing
 * estimated text-only budget. Missing entries require a fresh extraction. */
export async function selectPartialTextCache(
  texts: Map<string, string>, totals: Map<string, number>, requested: string,
  maxBytes: number, guard: Guard, preferred: readonly string[] = [], allowUnfit = false,
): Promise<{ texts: Map<string, string>; totals: Map<string, number>; bytes: number } | undefined> {
  const selected = new Map<string, string>(), selectedTotals = new Map<string, number>();
  let bytes = 0;
  const add = (ref: string) => {
    if (selected.has(ref)) return true;
    const text = texts.get(ref), total = totals.get(ref);
    if (text === undefined || total === undefined) return false;
    // Same estimate as the full cache: two references plus text and total.
    const size = 4 * ref.length + 2 * text.length + 16;
    if (size > maxBytes - bytes) return false;
    selected.set(ref, text); selectedTotals.set(ref, total); bytes += size;
    return true;
  };
  if (!add(requested) && !allowUnfit) { guard.check(); return undefined; }
  let count = 0;
  for (const ref of preferred) {
    if ((++count & 127) === 0) await guard.tick();
    add(ref);
  }
  for (const ref of texts.keys()) {
    if ((++count & 127) === 0) await guard.tick();
    if (ref !== requested) add(ref);
  }
  guard.check();
  // Unread fill entries are least recent; preserve the prior order for actual
  // reads, then place this requested paragraph last as the newest entry.
  const recent = new Set(preferred), order = [...selected.keys()].filter(ref => ref !== requested && !recent.has(ref));
  for (const ref of [...preferred].reverse()) if (ref !== requested && selected.has(ref)) order.push(ref);
  if (selected.has(requested)) order.push(requested);
  return {
    texts: new Map(order.map(ref => [ref, selected.get(ref)!])),
    totals: selectedTotals,
    bytes,
  };
}
