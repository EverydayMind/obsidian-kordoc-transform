import type { StyleSnapshot } from './types';
import { extractHwpx } from './hwpx';
import { extractHwp5 } from './hwp5';
import { Guard, LIMITS, StyleError } from './limits';
import { byteDigest, canonicalDigest } from './digest';
import { validateSnapshot } from './validate';
import { analyzeSemantic, analyzeSemanticEvidence, type SemanticAnalysis } from './semantic';
import { captureSemanticEvidence, validateSemanticEvidence, type SemanticEvidence } from './semantic-evidence';
import { copyBoundedJson } from './bounded-json';
import { STYLE_TEXT_CACHE_MAX_BYTES, StyleTextCache } from './text-cache';
import { selectPartialTextCache } from './partial-text-cache';
import { buildTextRangeIndex, RANGE_INDEX_STRIDE, planTextRangeIndex } from './text-range-index';
import { makeTextWindow, readTextWindow, type TextWindow } from './text-window-cache';
import { packSnapshotForExperiment, unpackSnapshotForExperiment } from './compact-snapshot.mjs';
import { resolveRootAnchors, validateRootAnchors, type RootAnchor } from './root-anchors';
import { readBoundedZip } from './zip';
export { canonicalDigest } from './digest';
export { buildRelations, cellRelationScope } from './buildRelations';
export { StyleError } from './limits';
export type { StyleSnapshot } from './types';

type RangeText = { texts: Map<string, string>; totals: Map<string, number>; measurementSha256: string; indexes?: Map<string, Uint32Array>; window?: TextWindow };
const rangeCache = new StyleTextCache<RangeText>();
export function clearStyleTextCache(): void { rangeCache.clear(); }

async function analyze(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal, snapshotLimit: number = LIMITS.snapshot) {
  const guard = new Guard(signal); guard.check();
  if (bytes.length > LIMITS.input) throw new StyleError('too_large', 'Input exceeds 32 MiB.');
  if (source.size !== bytes.length || source.sha256 !== byteDigest(bytes)) throw new StyleError('corrupted', 'Invalid source size.');
  const hwpx = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const hwp5 = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if ((!hwpx && !hwp5) || source.format !== (hwpx ? 'hwpx' : 'hwp5')) throw new StyleError('unsupported', 'Source format/signature mismatch.');
  const result = hwpx ? await extractHwpx(bytes, source, guard) : await extractHwp5(bytes, source, guard);
  guard.check(); validateSnapshot(result.snapshot, snapshotLimit); guard.check();
  return result;
}
export async function extractStyleBytes(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal): Promise<StyleSnapshot> { return (await analyze(bytes, source, signal)).snapshot; }
/** Internal partial coordinate bridge; supplied anchors remain caller-provided facts, not editing authority. */
export async function resolveHwpxRootAnchorsBytes(bytes: Uint8Array, evidence: { archiveSha256: string; sectionSha256: string; anchors: RootAnchor[] }, signal?: AbortSignal) {
  const guard = new Guard(signal); guard.check();
  const fixed = copyBoundedJson(evidence, 512 * 1024) as typeof evidence;
  if (!fixed || typeof fixed.archiveSha256 !== 'string' || typeof fixed.sectionSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fixed.archiveSha256) || !/^[a-f0-9]{64}$/.test(fixed.sectionSha256) ||
      !Array.isArray(fixed.anchors) || fixed.anchors.length > 5000 || bytes.length > LIMITS.input)
    throw new StyleError('corrupted', 'Output archive identity mismatch.');
  validateRootAnchors(fixed.anchors);
  const stableBytes = Uint8Array.from(bytes);
  if (byteDigest(stableBytes) !== fixed.archiveSha256) throw new StyleError('corrupted', 'Output archive identity mismatch.');
  const zip = await readBoundedZip(stableBytes, guard);
  const sections = [...zip.keys()].filter(name => /^Contents\/section\d+\.xml$/.test(name));
  const section = zip.get('Contents/section0.xml');
  if (sections.length !== 1 || !section || byteDigest(section) !== fixed.sectionSha256)
    throw new StyleError('corrupted', 'Output section identity mismatch.');
  const snapshot = await extractStyleBytes(stableBytes, { sha256: fixed.archiveSha256, size: stableBytes.length, format: 'hwpx' }, signal);
  return { archiveSha256: fixed.archiveSha256, sectionSha256: fixed.sectionSha256,
    anchors: resolveRootAnchors(snapshot, fixed.anchors) };
}
/** Opt-in provisional transport; existing snapshot/1 extraction stays unchanged. */
export async function extractCompactStyleBytes(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal) {
  const guard = new Guard(signal); guard.check();
  const snapshot = (await analyze(bytes, source, signal, 16 * 1024 * 1024)).snapshot;
  try {
    const result = packSnapshotForExperiment(snapshot);
    guard.check(); return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'packedBytes' in error) throw new StyleError('too_large', 'Compact snapshot exceeds 4 MiB.');
    throw error;
  }
}
/** Restore only against a separately supplied measurement hash. */
export async function restoreCompactStyle(input: unknown, expectedMeasurementSha256: string, signal?: AbortSignal): Promise<StyleSnapshot> {
  const guard = new Guard(signal); guard.check();
  const snapshot = unpackSnapshotForExperiment(input, expectedMeasurementSha256) as StyleSnapshot;
  guard.check(); return snapshot;
}
export async function extractSemanticBytes(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal): Promise<{ snapshot: StyleSnapshot; analysis: SemanticAnalysis }> {
  const extracted = await analyze(bytes, source, signal);
  return { snapshot: extracted.snapshot, analysis: await analyzeSemantic(extracted.snapshot, extracted.texts, signal, extracted.automaticMarkers, extracted.pageNumberControls, extracted.scriptRuns) };
}
/** Provisional text-free evidence; it does not claim the final snapshot-v2 contract. */
export async function extractSemanticEvidenceBytes(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal): Promise<{ snapshot: StyleSnapshot; evidence: SemanticEvidence; analysis: SemanticAnalysis }> {
  const extracted = await analyze(bytes, source, signal);
  const evidence = await captureSemanticEvidence(extracted.snapshot, extracted.texts, signal, undefined, undefined, true, extracted.automaticMarkers, extracted.pageNumberControls, extracted.scriptRuns);
  const analysis = await analyzeSemanticEvidence(extracted.snapshot, evidence, signal);
  return { snapshot: extracted.snapshot, evidence, analysis };
}
/** Provisional compact transport plus text-free evidence, captured in one parse. */
export async function extractCompactSemanticEvidenceBytes(bytes: Uint8Array, source: StyleSnapshot['source'], signal?: AbortSignal) {
  const guard = new Guard(signal); guard.check();
  const extracted = await analyze(bytes, source, signal, 16 * 1024 * 1024);
  const evidence = await captureSemanticEvidence(extracted.snapshot, extracted.texts, signal, guard, LIMITS.snapshot, true, extracted.automaticMarkers, extracted.pageNumberControls, extracted.scriptRuns);
  const analysis = await analyzeSemanticEvidence(extracted.snapshot, evidence, signal, guard, LIMITS.snapshot, 16 * 1024 * 1024);
  let packed: unknown;
  try { packed = packSnapshotForExperiment(extracted.snapshot); }
  catch (error) { if (error && typeof error === 'object' && 'packedBytes' in error) throw new StyleError('too_large', 'Compact snapshot exceeds 4 MiB.'); throw error; }
  guard.check();
  return { packed, evidence, evidenceSha256: canonicalDigest(evidence), analysis, analysisSha256: canonicalDigest(analysis) };
}
/** Source-free replay of independently bound compact snapshot and evidence. */
export async function reanalyzeCompactSemanticEvidence(packed: unknown, evidence: SemanticEvidence, expectedMeasurementSha256: string, expectedEvidenceSha256: string, signal?: AbortSignal) {
  const guard = new Guard(signal); guard.check();
  if (typeof expectedEvidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedEvidenceSha256)) throw new StyleError('corrupted', 'Expected evidence hash required.');
  const snapshot = unpackSnapshotForExperiment(packed, expectedMeasurementSha256) as StyleSnapshot;
  const safeEvidence = validateSemanticEvidence(snapshot, evidence, LIMITS.snapshot, 16 * 1024 * 1024);
  const evidenceSha256 = canonicalDigest(safeEvidence);
  if (evidenceSha256 !== expectedEvidenceSha256) throw new StyleError('source_changed', 'Semantic evidence changed.');
  const analysis = await analyzeSemanticEvidence(snapshot, safeEvidence, signal, guard, LIMITS.snapshot, 16 * 1024 * 1024);
  guard.check();
  return { measurementSha256: expectedMeasurementSha256, evidenceSha256, analysis, analysisSha256: canonicalDigest(analysis) };
}
/** Recompute rules from the saved evidence, without source bytes or source text. */
export async function reanalyzeSemanticEvidence(snapshot: StyleSnapshot, evidence: SemanticEvidence, expectedMeasurementSha256: string, expectedEvidenceSha256: string, signal?: AbortSignal): Promise<{ measurementSha256: string; evidenceSha256: string; analysis: SemanticAnalysis; analysisSha256: string }> {
  const guard = new Guard(signal); guard.check();
  if (typeof expectedMeasurementSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedMeasurementSha256) || typeof expectedEvidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedEvidenceSha256)) throw new StyleError('corrupted', 'Expected semantic hashes required.');
  const safeSnapshot = copyBoundedJson(snapshot, LIMITS.snapshot) as StyleSnapshot;
  validateSnapshot(safeSnapshot); guard.check();
  const safeEvidence = validateSemanticEvidence(safeSnapshot, evidence);
  const measurementSha256 = canonicalDigest(safeSnapshot), evidenceSha256 = canonicalDigest(safeEvidence);
  if (measurementSha256 !== expectedMeasurementSha256 || evidenceSha256 !== expectedEvidenceSha256) throw new StyleError('source_changed', 'Semantic evidence or measurement changed.');
  const analysis = await analyzeSemanticEvidence(safeSnapshot, safeEvidence, signal, guard);
  return { measurementSha256, evidenceSha256, analysis, analysisSha256: canonicalDigest(analysis) };
}
export async function inspectStyleBytes(bytes: Uint8Array, source: StyleSnapshot['source'], refs: string[], signal?: AbortSignal): Promise<Array<{ ref: string; text: string; truncated: boolean }>> {
  if (refs.length > 50 || new Set(refs).size !== refs.length) throw new StyleError('too_large', 'Inspect accepts at most 50 unique references.');
  const { texts } = await analyze(bytes, source, signal);
  const result = refs.map(ref => { const text = texts.get(ref); if (text === undefined) throw new StyleError('corrupted', 'Unknown paragraph reference.'); const points = [...text]; return { ref, text: points.slice(0, 160).join(''), truncated: points.length > 160 }; });
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) throw new StyleError('too_large', 'Inspect exceeds 16 KiB.');
  return result;
}

/** Advisory exact-substring check. Only candidate indices leave this runtime;
 * neither source text nor matching excerpts are returned or persisted. */
export async function inspectStyleOverlapBytes(bytes: Uint8Array, source: StyleSnapshot['source'], candidates: string[], signal?: AbortSignal): Promise<{ measurementSha256: string; matchedIndices: number[]; checkedCandidates: number }> {
  const guard = new Guard(signal); guard.check();
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 64 || candidates.some(value => typeof value !== 'string' || value.length > 256 || [...value].length < 6 || [...value].length > 128)) throw new StyleError('corrupted', 'Invalid overlap candidates.');
  const normalized = candidates.map(value => value.normalize('NFKC').toLowerCase());
  if (normalized.some(value => [...value].length < 6 || [...value].length > 256)) throw new StyleError('corrupted', 'Invalid normalized candidate.');
  // This returns only indices and a digest, not the expanded snapshot.
  const { texts, snapshot } = await analyze(bytes, source, signal, 16 * 1024 * 1024);
  const matched = new Set<number>();
  for (const paragraph of snapshot.paragraphs) {
    await guard.tick();
    const text = texts.get(paragraph.ref);
    if (text === undefined) throw new StyleError('corrupted', 'Overlap source text is incomplete.');
    let points = 0;
    for (let offset = 0; offset < text.length;) { const point = text.codePointAt(offset); offset += point !== undefined && point > 0xffff ? 2 : 1; if ((++points & 2047) === 0) await guard.tick(); }
    if (points !== paragraph.textCodePoints) throw new StyleError('corrupted', 'Overlap source text length mismatch.');
    if (matched.size < normalized.length) {
      const normalizedText = text.normalize('NFKC').toLowerCase();
      for (let i = 0; i < normalized.length; i++) if (!matched.has(i) && normalizedText.includes(normalized[i])) matched.add(i);
    }
  }
  guard.check();
  return { measurementSha256: canonicalDigest(snapshot), matchedIndices: [...matched].sort((a, b) => a - b), checkedCandidates: candidates.length };
}

/** A separately requested, bounded range; the original inspect contract remains unchanged. */
export async function inspectStyleTextRangeBytes(bytes: Uint8Array, source: StyleSnapshot['source'], ref: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ measurementSha256: string; ref: string; offset: number; text: string; total: number; nextOffset: number | null }> {
  if (typeof ref !== 'string' || !ref || ref.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new StyleError('corrupted', 'Invalid text range.');
  const guard = new Guard(signal); guard.check();
  if (source.size !== bytes.length || source.sha256 !== byteDigest(bytes)) throw new StyleError('corrupted', 'Invalid source size.');
  const key = `${source.format}:${source.size}:${source.sha256}`;
  let cached = rangeCache.get(key);
  if (cached?.window?.ref === ref) {
    if (offset > cached.window.total) throw new StyleError('corrupted', 'Text offset exceeds paragraph.');
    const text = await readTextWindow(cached.window, offset, limit, guard);
    if (text !== undefined) {
      const total = cached.window.total, end = Math.min(offset + limit, total);
      const result = { measurementSha256: cached.measurementSha256, ref, offset, text, total, nextOffset: end < total ? end : null };
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024) throw new StyleError('too_large', 'Text range exceeds 8 KiB.');
      return result;
    }
  }
  const priorWindow = cached?.window && cached.window.ref !== ref ? { value: cached.window, measurementSha256: cached.measurementSha256 } : undefined;
  const preferred = cached && !cached.texts.has(ref) ? [...cached.texts.keys()].reverse() : [];
  if (cached && !cached.texts.has(ref)) cached = undefined;
  const version = rangeCache.version();
  let cacheBytes = 0;
  if (!cached) {
    // A range returns at most 512 code points and is not a persisted snapshot.
    // Permit the same expanded measurement bound as the compact transport;
    // the text cache retains its independent 2 MiB and 60-second limits.
    const { texts: extractedTexts, snapshot } = await analyze(bytes, source, signal, 16 * 1024 * 1024);
    let texts = extractedTexts;
    let totals = new Map(snapshot.paragraphs.map(p => [p.ref, p.textCodePoints]));
    const measurementSha256 = canonicalDigest(snapshot);
    let retainedWindow: TextWindow | undefined;
    for (const [ref, text] of texts) cacheBytes += 2 * (ref.length + text.length);
    for (const ref of totals.keys()) cacheBytes += 2 * ref.length + 16;
    if (cacheBytes > STYLE_TEXT_CACHE_MAX_BYTES) {
      const priorBytes = priorWindow && priorWindow.measurementSha256 === measurementSha256
        ? 2 * (priorWindow.value.ref.length + priorWindow.value.text.length) + 64 : 0;
      let partial = await selectPartialTextCache(texts, totals, ref, STYLE_TEXT_CACHE_MAX_BYTES - priorBytes, guard, preferred);
      if (partial && priorBytes) retainedWindow = priorWindow!.value;
      if (!partial && priorBytes) partial = await selectPartialTextCache(texts, totals, ref, STYLE_TEXT_CACHE_MAX_BYTES, guard, preferred);
      if (partial) { texts = partial.texts; totals = partial.totals; cacheBytes = partial.bytes + (retainedWindow ? priorBytes : 0); }
    }
    // Reserve every possible sparse index before storing any of them; do not
    // reduce the existing text-only cache coverage when the reservation fails.
    const indexBytes = planTextRangeIndex(cacheBytes, totals.values(), STYLE_TEXT_CACHE_MAX_BYTES);
    const indexes = indexBytes === undefined ? undefined : new Map<string, Uint32Array>();
    if (indexBytes !== undefined) cacheBytes += indexBytes;
    cached = { texts, totals, measurementSha256, indexes, window: retainedWindow };
  }
  const { texts, totals, measurementSha256 } = cached;
  const value = texts.get(ref);
  if (value === undefined) throw new StyleError('corrupted', 'Unknown paragraph reference.');
  const total = totals.get(ref);
  if (total === undefined) throw new StyleError('corrupted', 'Unknown paragraph reference.');
  if (offset > total) throw new StyleError('corrupted', 'Text offset exceeds paragraph.');
  const end = Math.min(offset + limit, total), selected: string[] = [];
  let positions = cached.indexes?.get(ref);
  if (!positions && cached.indexes && offset >= RANGE_INDEX_STRIDE) {
    positions = await buildTextRangeIndex(value, total, guard);
    cached.indexes.set(ref, positions);
  }
  const checkpoint = positions ? Math.floor(offset / RANGE_INDEX_STRIDE) : 0;
  let index = checkpoint * RANGE_INDEX_STRIDE, unit = positions?.[checkpoint] ?? 0, startUnit: number | undefined;
  while (index < end && unit < value.length) {
    if ((index & 2047) === 0) await guard.tick();
    if (index === offset) startUnit = unit;
    const cp = value.codePointAt(unit)!;
    const point = String.fromCodePoint(cp);
    if (index >= offset) selected.push(point);
    unit += point.length; index++;
  }
  if (index !== end) throw new StyleError('corrupted', 'Text length differs from measurement.');
  const result = { measurementSha256, ref, offset, text: selected.join(''), total, nextOffset: end < total ? end : null };
  guard.check();
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024) throw new StyleError('too_large', 'Text range exceeds 8 KiB.');
  if (cacheBytes > STYLE_TEXT_CACHE_MAX_BYTES && startUnit !== undefined) {
    const window = await makeTextWindow(ref, value, total, offset, startUnit, guard);
    let bytes = 2 * (ref.length + window.text.length) + 64;
    const other = await selectPartialTextCache(texts, totals, ref, STYLE_TEXT_CACHE_MAX_BYTES - bytes, guard, preferred, true);
    if (!other) throw new StyleError('corrupted', 'Cannot select cached text.');
    bytes += other.bytes;
    const indexBytes = planTextRangeIndex(bytes, other.totals.values(), STYLE_TEXT_CACHE_MAX_BYTES);
    const indexes = indexBytes === undefined ? undefined : new Map<string, Uint32Array>();
    if (indexBytes !== undefined) bytes += indexBytes;
    rangeCache.put(key, { texts: other.texts, totals: other.totals, measurementSha256, indexes, window }, bytes, version);
    return result;
  }
  // Update recency only after a valid result, without extending the TTL.
  cached.texts.delete(ref);
  cached.texts.set(ref, value);
  if (cacheBytes) rangeCache.put(key, cached, cacheBytes, version);
  return result;
}
