import type { ParseOptions, ParseResult } from './engine';
import type { ParseWorkerPool } from './batch-worker';

/** Parse PDF pages separately: cross-page table merging loses source-page identity. */
export async function parseIndexSource(pool: ParseWorkerPool, bytes: ArrayBuffer, pdf: boolean, options: ParseOptions, signal?: AbortSignal): Promise<ParseResult & { indexBatched?: boolean }> {
  const check = () => { if (signal?.aborted) throw new Error('Index extraction aborted'); };
  check();
  const first = await pool.parse(bytes, { ...options, ...(pdf ? { pages: '1' } : {}) });
  check();
  if (!first.success || !pdf || (first.pageCount ?? 0) <= 1) return first;
  const candidates = [...(first.qualitySummary?.ocrCandidatePages ?? [])];
  const pageCount = first.pageCount ?? 0;
  const blocks = [...first.blocks], warnings = [...(first.warnings ?? [])], outline = [...(first.outline ?? [])], qualities = [...(first.pageQuality ?? [])];
  for (let start = 2; start <= pageCount; start++) {
    check();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const next = await pool.parse(bytes, { ...options, pages: String(start) });
    check();
    if (!next.success) return next;
    blocks.push(...next.blocks); warnings.push(...(next.warnings ?? [])); outline.push(...(next.outline ?? [])); qualities.push(...(next.pageQuality ?? [])); candidates.push(...(next.qualitySummary?.ocrCandidatePages ?? []));
  }
  const summary = first.qualitySummary ? { ...first.qualitySummary, totalPages: pageCount, totalTextChars: qualities.reduce((n, q) => n + q.textChars, 0), lowTextPageCount: qualities.filter((q) => q.textChars < 200).length, needsOcr: candidates.length > 0, ocrCandidatePages: [...new Set(candidates)] } : undefined;
  return { ...first, blocks, warnings, outline, pageQuality: qualities, ...(summary ? { qualitySummary: summary } : {}), markdown: '', indexBatched: true };
}
