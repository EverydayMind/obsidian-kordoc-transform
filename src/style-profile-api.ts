import { createHash } from 'node:crypto';
import type { App } from 'obsidian';
import { vaultFileByPath } from './vault-file';
import { loadStyleProfile } from './style-profile-loader';
import type { StyleSnapshot } from './style-profile/types';
import type { SemanticAnalysis } from './style-profile/semantic';
import type { SemanticEvidence } from './style-profile/semantic-evidence';
import { Guard, LIMITS, StyleError, type FailureCode } from './style-profile/limits';
import { copyBoundedJson } from './style-profile/bounded-json';
import type { RootAnchor } from './style-profile/root-anchors';

export type StyleFailure = { status: 'error'; code: FailureCode; message: string; retry: 'after_input_change' | 'new_request' | 'never' };
export interface StyleProfileApiV1 {
  version: 1;
  extract(input: { path: string; expectedSha256?: string; signal?: AbortSignal }): Promise<{ status: 'ok'; sourcePath: string; snapshot: StyleSnapshot; measurementSha256: string } | StyleFailure>;
  extractCompact(input: { path: string; expectedSha256?: string; signal?: AbortSignal }): Promise<{ status: 'ok'; sourcePath: string; packed: unknown; measurementSha256: string } | StyleFailure>;
  restoreCompact(input: { packed: unknown; expectedMeasurementSha256: string; signal?: AbortSignal }): Promise<{ status: 'ok'; snapshot: StyleSnapshot; measurementSha256: string } | StyleFailure>;
  inspect(input: { path: string; expectedSha256: string; refs: string[]; signal?: AbortSignal }): Promise<{ status: 'ok'; sourceSha256: string; nodes: Array<{ ref: string; text: string; truncated: boolean }> } | StyleFailure>;
  inspectTextRange(input: { path: string; expectedSha256: string; ref: string; offset: number; limit: number; signal?: AbortSignal }): Promise<{ status: 'ok'; sourceSha256: string; measurementSha256: string; ref: string; offset: number; text: string; total: number; nextOffset: number | null } | StyleFailure>;
  inspectTextOverlap(input: { path: string; expectedSha256: string; candidates: string[]; signal?: AbortSignal }): Promise<{ status: 'ok'; sourceSha256: string; measurementSha256: string; matchedIndices: number[]; checkedCandidates: number } | StyleFailure>;
  /** Optional on older v1 providers. Caller-supplied positions are not edit authority. */
  resolveOutputAnchors?(input: { path: string; expectedSha256: string; sectionSha256: string; anchors: RootAnchor[]; signal?: AbortSignal }): Promise<{ status: 'ok'; archiveSha256: string; sectionSha256: string; anchors: Array<{ blockIndex: number; state: 'matched'; ref: string } | { blockIndex: number; state: 'unavailable'; reason: 'paragraph_missing' }> } | StyleFailure>;
  extractSemantic(input: { path: string; expectedSha256?: string; signal?: AbortSignal }): Promise<{ status: 'ok'; sourcePath: string; snapshot: StyleSnapshot; measurementSha256: string; analysis: SemanticAnalysis; analysisSha256: string } | StyleFailure>;
  extractSemanticEvidence(input: { path: string; expectedSha256?: string; signal?: AbortSignal }): Promise<{ status: 'ok'; sourcePath: string; snapshot: StyleSnapshot; measurementSha256: string; evidence: SemanticEvidence; evidenceSha256: string; analysis: SemanticAnalysis; analysisSha256: string } | StyleFailure>;
  extractCompactSemanticEvidence(input: { path: string; expectedSha256?: string; signal?: AbortSignal }): Promise<{ status: 'ok'; sourcePath: string; packed: unknown; measurementSha256: string; evidence: SemanticEvidence; evidenceSha256: string; analysis: SemanticAnalysis; analysisSha256: string } | StyleFailure>;
  reanalyzeCompactSemanticEvidence(input: { packed: unknown; evidence: SemanticEvidence; expectedMeasurementSha256: string; expectedEvidenceSha256: string; signal?: AbortSignal }): Promise<{ status: 'ok'; measurementSha256: string; evidenceSha256: string; analysis: SemanticAnalysis; analysisSha256: string } | StyleFailure>;
  reanalyzeSemanticEvidence(input: { snapshot: StyleSnapshot; evidence: SemanticEvidence; expectedMeasurementSha256: string; expectedEvidenceSha256: string; signal?: AbortSignal }): Promise<{ status: 'ok'; measurementSha256: string; evidenceSha256: string; analysis: SemanticAnalysis; analysisSha256: string } | StyleFailure>;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failure = (error: unknown): StyleFailure => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ['not_found', 'unsupported', 'encrypted', 'drm', 'corrupted', 'too_large', 'bomb', 'source_changed', 'cancelled', 'timeout', 'busy', 'extractor_unavailable'].includes(error.code) ? error.code as FailureCode : 'corrupted';
  return { status: 'error', code, message: error instanceof Error ? error.message : 'Style extraction failed.', retry: ['busy', 'cancelled', 'timeout', 'extractor_unavailable'].includes(code) ? 'new_request' : 'after_input_change' };
};

/** Serial host-only read API; a cancelled parser retains its slot until it has
 * actually returned. There is no Promise.race which could overlap runtimes. */
export function createStyleProfileApi(app: App, load = loadStyleProfile): StyleProfileApiV1 {
  let pending = 0, tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T | StyleFailure> => {
    if (pending >= 2) return Promise.resolve(failure(new StyleError('busy', 'Style measurement queue is full.')));
    pending++;
    const result = tail.then(work).catch(failure).finally(() => { pending--; });
    tail = result; return result;
  };
  const analyze = async (input: { path: string; expectedSha256?: string; signal?: AbortSignal }, refs?: string[], semantic: boolean | 'evidence' | 'compact' | 'compact-evidence' = false, range?: { ref: string; offset: number; limit: number }, overlap?: string[], anchors?: { sectionSha256: string; anchors: RootAnchor[] }) => {
    const guard = new Guard(input.signal); guard.check();
    const path = input.path;
    // Control characters are forbidden in Vault paths.
    // eslint-disable-next-line no-control-regex -- Reject control characters in paths.
    if (typeof path !== 'string' || !path || path.length > 4096 || /^[A-Za-z]:|^\//.test(path) || /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part.startsWith('.')) || path === app.vault.configDir || path.startsWith(`${app.vault.configDir}/`)) throw new StyleError('unsupported', 'User Vault relative path required.');
    if (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new StyleError('corrupted', 'Invalid expected hash.');
    const file = vaultFileByPath(app.vault, path);
    if (!file) throw new StyleError('not_found', 'Source file not found.');
    if (!/^(hwp|hwpx)$/i.test(file.extension)) throw new StyleError('unsupported', 'HWP/HWPX source required.');
    if (file.stat.size > LIMITS.input) throw new StyleError('too_large', 'Input exceeds 32 MiB.');
    const bytes = new Uint8Array(await app.vault.readBinary(file)); guard.check();
    if (bytes.length > LIMITS.input) throw new StyleError('too_large', 'Input exceeds 32 MiB.');
    const sha256 = hash(bytes);
    if (input.expectedSha256 && sha256 !== input.expectedSha256) throw new StyleError('source_changed', 'Source hash changed.');
    const format = bytes[0] === 0xd0 && bytes[1] === 0xcf ? 'hwp5' : bytes[0] === 0x50 && bytes[1] === 0x4b ? 'hwpx' : null;
    if (!format) throw new StyleError('unsupported', 'Unsupported file signature.');
    let runtime: ReturnType<typeof load>;
    try { runtime = load(); } catch { throw new StyleError('extractor_unavailable', 'Style runtime could not be loaded.'); }
    const source: StyleSnapshot['source'] = { sha256, size: bytes.length, format };
    if (anchors && (format !== 'hwpx' || !input.expectedSha256)) throw new StyleError('unsupported', 'Bound HWPX output required.');
    if (anchors && typeof runtime.resolveHwpxRootAnchorsBytes !== 'function') throw new StyleError('extractor_unavailable', 'Output anchor runtime unavailable.');
    if (range && typeof runtime.inspectStyleTextRangeBytes !== 'function') throw new StyleError('extractor_unavailable', 'Style range runtime unavailable.');
    if (overlap && typeof runtime.inspectStyleOverlapBytes !== 'function') throw new StyleError('extractor_unavailable', 'Style overlap runtime unavailable.');
    if (semantic === 'evidence' && typeof runtime.extractSemanticEvidenceBytes !== 'function') throw new StyleError('extractor_unavailable', 'Semantic evidence runtime unavailable.');
    if (semantic === 'compact' && typeof runtime.extractCompactStyleBytes !== 'function') throw new StyleError('extractor_unavailable', 'Compact style runtime unavailable.');
    if (semantic === 'compact-evidence' && typeof runtime.extractCompactSemanticEvidenceBytes !== 'function') throw new StyleError('extractor_unavailable', 'Compact semantic runtime unavailable.');
    const value = anchors ? await runtime.resolveHwpxRootAnchorsBytes(bytes, { archiveSha256: sha256, ...anchors }, input.signal) : overlap ? await runtime.inspectStyleOverlapBytes(bytes, source, overlap, input.signal) : range ? await runtime.inspectStyleTextRangeBytes(bytes, source, range.ref, range.offset, range.limit, input.signal) : refs ? await runtime.inspectStyleBytes(bytes, source, refs, input.signal) : semantic === 'compact-evidence' ? await runtime.extractCompactSemanticEvidenceBytes(bytes, source, input.signal) : semantic === 'compact' ? await runtime.extractCompactStyleBytes(bytes, source, input.signal) : semantic === 'evidence' ? await runtime.extractSemanticEvidenceBytes(bytes, source, input.signal) : semantic ? await runtime.extractSemanticBytes(bytes, source, input.signal) : await runtime.extractStyleBytes(bytes, source, input.signal);
    guard.check();
    const currentFile = vaultFileByPath(app.vault, path);
    if (!currentFile || currentFile.stat.size > LIMITS.input || hash(new Uint8Array(await app.vault.readBinary(currentFile))) !== sha256) throw new StyleError('source_changed', 'Source changed during measurement.');
    guard.check();
    if (anchors) return { status: 'ok' as const, ...(value as Awaited<ReturnType<typeof runtime.resolveHwpxRootAnchorsBytes>>) };
    if (overlap) return { status: 'ok' as const, sourceSha256: sha256, ...(value as { measurementSha256: string; matchedIndices: number[]; checkedCandidates: number }) };
    if (range) return { status: 'ok' as const, sourceSha256: sha256, ...(value as { measurementSha256: string; ref: string; offset: number; text: string; total: number; nextOffset: number | null }) };
    if (refs) return { status: 'ok' as const, sourceSha256: sha256, nodes: value as Array<{ ref: string; text: string; truncated: boolean }> };
    if (semantic === 'compact-evidence') { const result = value as Awaited<ReturnType<typeof runtime.extractCompactSemanticEvidenceBytes>>; const packed: unknown = result.packed; if (!packed || typeof packed !== 'object' || !('measurementSha256' in packed) || typeof packed.measurementSha256 !== 'string') throw new StyleError('corrupted', 'Invalid compact measurement.'); return { status: 'ok' as const, sourcePath: path, ...result, measurementSha256: packed.measurementSha256 }; }
    if (semantic === 'compact') return { status: 'ok' as const, sourcePath: path, packed: value, measurementSha256: (value as { measurementSha256: string }).measurementSha256 };
    if (semantic) {
      const result = value as { snapshot: StyleSnapshot; analysis: SemanticAnalysis; evidence?: SemanticEvidence };
      return { status: 'ok' as const, sourcePath: path, snapshot: result.snapshot, measurementSha256: runtime.canonicalDigest(result.snapshot), analysis: result.analysis, analysisSha256: runtime.canonicalDigest(result.analysis), ...(result.evidence ? { evidence: result.evidence, evidenceSha256: runtime.canonicalDigest(result.evidence) } : {}) };
    }
    return { status: 'ok' as const, sourcePath: path, snapshot: value as StyleSnapshot, measurementSha256: runtime.canonicalDigest(value) };
  };
  const reanalyze: StyleProfileApiV1['reanalyzeSemanticEvidence'] = input => {
    if (pending >= 2) return Promise.resolve(failure(new StyleError('busy', 'Style measurement queue is full.')));
    try {
      new Guard(input.signal).check();
      const request = { ...input, snapshot: copyBoundedJson(input.snapshot, LIMITS.snapshot) as StyleSnapshot,
        evidence: copyBoundedJson(input.evidence, LIMITS.snapshot) as SemanticEvidence };
      return enqueue(async () => {
        const guard = new Guard(request.signal); guard.check();
        let runtime: ReturnType<typeof load>;
        try { runtime = load(); } catch { throw new StyleError('extractor_unavailable', 'Style runtime could not be loaded.'); }
        if (typeof runtime.reanalyzeSemanticEvidence !== 'function') throw new StyleError('extractor_unavailable', 'Semantic evidence runtime unavailable.');
        const result = await runtime.reanalyzeSemanticEvidence(request.snapshot, request.evidence, request.expectedMeasurementSha256, request.expectedEvidenceSha256, request.signal);
        guard.check(); return { status: 'ok' as const, ...result };
      });
    } catch (error) { return Promise.resolve(failure(error)); }
  };
  const restoreCompact: StyleProfileApiV1['restoreCompact'] = input => {
    if (pending >= 2) return Promise.resolve(failure(new StyleError('busy', 'Style measurement queue is full.')));
    try {
      new Guard(input.signal).check();
      const request = { packed: copyBoundedJson(input.packed, LIMITS.snapshot), expectedMeasurementSha256: input.expectedMeasurementSha256, signal: input.signal };
      return enqueue(async () => {
        const guard = new Guard(request.signal); guard.check();
        let runtime: ReturnType<typeof load>;
        try { runtime = load(); } catch { throw new StyleError('extractor_unavailable', 'Style runtime could not be loaded.'); }
        if (typeof runtime.restoreCompactStyle !== 'function') throw new StyleError('extractor_unavailable', 'Compact style runtime unavailable.');
        const snapshot = await runtime.restoreCompactStyle(request.packed, request.expectedMeasurementSha256, request.signal);
        guard.check();
        return { status: 'ok' as const, snapshot, measurementSha256: request.expectedMeasurementSha256 };
      });
    } catch (error) { return Promise.resolve(failure(error)); }
  };
  const reanalyzeCompact: StyleProfileApiV1['reanalyzeCompactSemanticEvidence'] = input => {
    if (pending >= 2) return Promise.resolve(failure(new StyleError('busy', 'Style measurement queue is full.')));
    try {
      new Guard(input.signal).check();
      const request = { packed: copyBoundedJson(input.packed, LIMITS.snapshot), evidence: copyBoundedJson(input.evidence, LIMITS.snapshot) as SemanticEvidence, expectedMeasurementSha256: input.expectedMeasurementSha256, expectedEvidenceSha256: input.expectedEvidenceSha256, signal: input.signal };
      return enqueue(async () => {
        const guard = new Guard(request.signal); guard.check();
        let runtime: ReturnType<typeof load>;
        try { runtime = load(); } catch { throw new StyleError('extractor_unavailable', 'Style runtime could not be loaded.'); }
        if (typeof runtime.reanalyzeCompactSemanticEvidence !== 'function') throw new StyleError('extractor_unavailable', 'Compact semantic runtime unavailable.');
        const result = await runtime.reanalyzeCompactSemanticEvidence(request.packed, request.evidence, request.expectedMeasurementSha256, request.expectedEvidenceSha256, request.signal);
        guard.check(); return { status: 'ok' as const, ...result };
      });
    } catch (error) { return Promise.resolve(failure(error)); }
  };
  const resolveOutputAnchors: NonNullable<StyleProfileApiV1['resolveOutputAnchors']> = input => {
    if (pending >= 2) return Promise.resolve(failure(new StyleError('busy', 'Style measurement queue is full.')));
    try {
      new Guard(input.signal).check();
      const request = { path: input.path, expectedSha256: input.expectedSha256, sectionSha256: input.sectionSha256,
        anchors: copyBoundedJson(input.anchors, 512 * 1024) as RootAnchor[], signal: input.signal };
      return enqueue(() => analyze(request, undefined, false, undefined, undefined,
        { sectionSha256: request.sectionSha256, anchors: request.anchors })) as ReturnType<NonNullable<StyleProfileApiV1['resolveOutputAnchors']>>;
    } catch (error) { return Promise.resolve(failure(error)); }
  };
  return { version: 1, resolveOutputAnchors, extractCompactSemanticEvidence: input => { const snapshot = { ...input }; return enqueue(() => analyze(snapshot, undefined, 'compact-evidence')) as ReturnType<StyleProfileApiV1['extractCompactSemanticEvidence']>; }, reanalyzeCompactSemanticEvidence: reanalyzeCompact, inspectTextOverlap: input => { const snapshot = { ...input, candidates: Array.isArray(input.candidates) ? [...input.candidates] : input.candidates }; return enqueue(() => { if (!snapshot.expectedSha256 || !Array.isArray(snapshot.candidates)) throw new StyleError('corrupted', 'Overlap requires hash and candidates.'); return analyze(snapshot, undefined, false, undefined, snapshot.candidates); }) as ReturnType<StyleProfileApiV1['inspectTextOverlap']>; }, extract: input => { const snapshot = { ...input }; return enqueue(() => analyze(snapshot)) as ReturnType<StyleProfileApiV1['extract']>; }, extractCompact: input => { const snapshot = { ...input }; return enqueue(() => analyze(snapshot, undefined, 'compact')) as ReturnType<StyleProfileApiV1['extractCompact']>; }, restoreCompact, extractSemantic: input => { const snapshot = { ...input }; return enqueue(() => analyze(snapshot, undefined, true)) as ReturnType<StyleProfileApiV1['extractSemantic']>; }, extractSemanticEvidence: input => { const snapshot = { ...input }; return enqueue(() => analyze(snapshot, undefined, 'evidence')) as ReturnType<StyleProfileApiV1['extractSemanticEvidence']>; }, reanalyzeSemanticEvidence: reanalyze, inspect: input => { const snapshot = { ...input, refs: Array.isArray(input.refs) ? [...input.refs] : input.refs }; return enqueue(() => { if (!snapshot.expectedSha256 || !Array.isArray(snapshot.refs)) throw new StyleError('corrupted', 'Inspect requires hash and references.'); return analyze(snapshot, snapshot.refs); }) as ReturnType<StyleProfileApiV1['inspect']>; }, inspectTextRange: input => { const snapshot = { ...input }; return enqueue(() => { if (!snapshot.expectedSha256) throw new StyleError('corrupted', 'Text range requires source hash.'); return analyze(snapshot, undefined, false, { ref: snapshot.ref, offset: snapshot.offset, limit: snapshot.limit }); }) as ReturnType<StyleProfileApiV1['inspectTextRange']>; } };
}
