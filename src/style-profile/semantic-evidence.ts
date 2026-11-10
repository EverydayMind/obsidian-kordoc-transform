import type { Paragraph, StyleSnapshot } from './types';
import validate from './generated/semantic-evidence.js';
import type { DiscourseRole, SemanticFeatures } from './semantic';
import { canonicalDigest } from './digest';
import { Guard, LIMITS, StyleError } from './limits';
import { inferSpans, measuredStyleDifference, type SpanResult } from './semantic-spans';
import { validateSnapshot } from './validate';
import { copyBoundedJson } from './bounded-json';
import { TEXT_FEATURES_VERSION, textFeatures, validTextFeatureBinding, type TextFeatures } from './text-features';
import { unknownAutomaticMarker, type AutomaticMarker } from './numbering';
import type { PageNumberControls } from './page-number-controls';
import { scriptSpanBound, type ScriptRuns, type ScriptState } from './script-runs';

type Prefix = SemanticFeatures['prefix'];
export type SemanticContainer = SemanticFeatures['container'];
export type TextEvidence = {
  ref: string; textLength: number; rawNonempty: boolean; contentNonempty: boolean;
  prefix: Prefix; prefixRank: number | null; prefixBullet: boolean;
  ending: SemanticFeatures['ending']; wordCount: number;
  caption: boolean; note: boolean; titleTerm: boolean; notice: boolean;
  organization: boolean; dateRaw: boolean; dateContent: boolean;
  discourse: Array<{ role: DiscourseRole; evidence: string }>;
} & SpanResult & { textFeatures?: TextFeatures; automaticMarker?: AutomaticMarker; scriptRuns?: ScriptState[] };
export type SemanticEvidence = { schema: 'report-style-semantic-evidence/0.1' | 'report-style-semantic-evidence/0.2' | 'report-style-semantic-evidence/0.3' | 'report-style-semantic-evidence/0.4' | 'report-style-semantic-evidence/0.5' | 'report-style-semantic-evidence/0.6' | 'report-style-semantic-evidence/0.7' | 'report-style-semantic-evidence/0.8'; ruleSetVersion: 'ko-structure/0.4' | 'ko-structure/0.5' | 'ko-structure/0.6' | 'ko-structure/0.7' | 'ko-structure/0.8' | 'ko-structure/0.9' | 'ko-structure/0.10'; textFeaturesVersion?: typeof TEXT_FEATURES_VERSION; measurementSha256: string; pageNumberControls?: PageNumberControls; nodes: TextEvidence[] };

const listSymbols = new Set(['-', '–', '—', '―', '•', '◦', '○', '●', 'ㅇ', 'ㆍ', '▪', '▶', '▷']);
const dateLine = /^\d{4}\s*(?:년|[.\-/])\s*\d{1,2}\s*(?:월|[.\-/])\s*\d{1,2}\s*(?:일|\.)?$/u;
const cues: Array<[DiscourseRole, RegExp, string]> = [
  ['BACKGROUND', /(?:배경|추진\s*경위|제정\s*이유|개정\s*이유)/u, 'text_background'],
  ['STATUS', /(?:현황|운영\s*실태|추진\s*실적)/u, 'text_status'],
  ['PROBLEM', /(?:문제점|애로사항|한계|부족|미흡)/u, 'text_problem'],
  ['OBJECTIVE', /(?:목적|목표|추진\s*방향|필요성)/u, 'text_objective'],
  ['ACTION', /(?:추진\s*계획|개선\s*방안|조치\s*계획|지원\s*방안)/u, 'text_action'],
  ['EFFECT', /(?:기대\s*효과|파급\s*효과|성과)/u, 'text_effect'],
  ['SUMMARY', /(?:요약|결론|종합\s*의견)/u, 'text_summary'],
];

function prefixOf(text: string): { kind: Prefix; rank: number | null; rest: string; bullet: boolean } {
  const clean = text.trimStart();
  const rules: Array<[RegExp, Prefix, number, boolean]> = [
    [/^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|[IVXLCDM]+[.)])\s*/u, 'ROMAN', 1, false],
    [/^\d{1,3}\.(?!\d)\s*/u, 'ARABIC_DOT', 2, false],
    [/^[가-하]\.\s*/u, 'KOREAN_DOT', 3, false],
    [/^\d{1,3}\)\s*/u, 'ARABIC_PAREN', 4, false],
    [/^[가-하]\)\s*/u, 'KOREAN_PAREN', 5, false],
    [/^\((?:\d{1,3}|[가-하])\)\s*/u, 'BOTH_PAREN', 6, false],
    [/^[①-⑳㉮-㉻]\s*/u, 'CIRCLED', 7, true],
    [/^[□■○●◦ㅇ•※▶▷▪◆◇ㆍ–—―-]\s*/u, 'SYMBOL', 8, false],
  ];
  for (const [pattern, kind, rank, bullet] of rules) {
    const match = pattern.exec(clean);
    if (match) return { kind, rank, rest: clean.slice(match[0].length), bullet: bullet || listSymbols.has(match[0].trim()) };
  }
  return { kind: 'NONE', rank: null, rest: clean, bullet: false };
}

function endingOf(text: string): SemanticFeatures['ending'] {
  const stripped = text.trim().replace(/[.!?。！？]+$/u, '').trim();
  if (!stripped) return 'empty';
  const words = stripped.split(/\s+/u);
  if (/[?！？]$/u.test(text.trim()) || /(?:다|니다|한다|된다|있다|없다|하였다|합니다|합니다만|해야\s*함|필요함)$/u.test(stripped)) return 'sentence';
  if (words.length >= 4 && /(?:은|는|이|가|을|를|으로|에서)(?:\s|$)/u.test(stripped)) return 'sentence';
  return words.length <= 4 ? 'noun_phrase' : 'other';
}

export async function semanticContainers(snapshot: StyleSnapshot, guard: Guard): Promise<Map<string, SemanticContainer>> {
  const refs = new Map(snapshot.nodes.map(node => [node.ref, node]));
  const containers = new Map<string, SemanticContainer>();
  const ancestors = new Map<string, 'body' | 'cell' | 'header' | 'footer'>();
  let traversed = 0;
  for (const p of snapshot.paragraphs) {
    await guard.tick();
    const direct = p.candidates.map(candidate => candidate.role);
    let container: SemanticContainer = direct.includes('FOOTNOTE') ? 'footnote' : direct.includes('CAPTION') ? 'caption' : 'body';
    let current = refs.get(p.ref)?.parentRef ?? null;
    const path: Array<{ ref: string; kind: string }> = [], seen = new Set<string>();
    while (current && !ancestors.has(current)) {
      if ((++traversed & 63) === 0) await guard.tick();
      if (seen.has(current)) throw new StyleError('corrupted', 'Semantic parent cycle.');
      seen.add(current);
      const parent = refs.get(current);
      if (!parent) throw new StyleError('corrupted', 'Invalid semantic parent reference.');
      path.push(parent);
      if (parent.kind === 'header' || parent.kind === 'footer') { current = null; break; }
      current = parent.parentRef;
    }
    let inherited = current ? ancestors.get(current)! : 'body';
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      if (node.kind === 'header' || node.kind === 'footer') inherited = node.kind;
      else if (node.kind === 'cell' && inherited === 'body') inherited = 'cell';
      ancestors.set(node.ref, inherited);
    }
    if (inherited === 'header' || inherited === 'footer') container = inherited;
    else if (inherited === 'cell' && container === 'body') container = 'cell';
    containers.set(p.ref, container);
  }
  return containers;
}

function measureText(p: Paragraph, text: string, container: SemanticContainer, snapshot: StyleSnapshot, measuredStyles: boolean, scripts?: ScriptState[]): TextEvidence {
  const prefix = prefixOf(text), stripped = prefix.rest.trim();
  return {
    ref: p.ref, textLength: [...text].length, rawNonempty: !!text.trim(), contentNonempty: !!stripped,
    prefix: prefix.kind, prefixRank: prefix.rank, prefixBullet: prefix.bullet,
    ending: endingOf(stripped), wordCount: stripped ? stripped.split(/\s+/u).length : 0,
    caption: /^(?:<|\[)?(?:표|그림|사진|도표|그래프)\s*\d/u.test(stripped), note: /^※/u.test(text.trimStart()),
    titleTerm: /(?:확인서|허가서|신청서|보고서|승인서|공고문)\s*$/u.test(stripped),
    notice: /(?:공고|고시)\s*제\s*\d{4}[-–]\d+/u.test(stripped),
    organization: /(?:부|처|청|위원회|공단|공사|과)\s*(?:장관|위원장)?$/u.test(stripped),
    dateRaw: dateLine.test(text.trim()), dateContent: dateLine.test(stripped),
    discourse: cues.flatMap(([role, pattern, evidence]) => pattern.test(stripped) ? [{ role, evidence }] : []),
    ...inferSpans(p, text, container === 'cell', measuredStyles ? (left, right) => measuredStyleDifference(snapshot.characterStyles, left, right) : undefined, scripts),
  };
}

/** Extract fixed classifications and ranges, never the source text itself. */
export async function captureSemanticEvidence(snapshot: StyleSnapshot, texts: Map<string, string>, signal?: AbortSignal, sharedGuard?: Guard, byteLimit = LIMITS.snapshot, includeTextFeatures = false, automaticMarkers?: Map<string, AutomaticMarker>, pageNumberControls?: PageNumberControls, scriptRuns?: ScriptRuns): Promise<SemanticEvidence> {
  const guard = sharedGuard ?? new Guard(signal); guard.check();
  const containers = await semanticContainers(snapshot, guard), nodes: TextEvidence[] = [];
  let size = 0;
  for (const paragraph of snapshot.paragraphs) {
    await guard.tick();
    const text = texts.get(paragraph.ref), container = containers.get(paragraph.ref);
    if (text === undefined || !container) throw new StyleError('corrupted', 'Missing semantic text or container.');
    const scripts = includeTextFeatures && automaticMarkers && pageNumberControls && scriptRuns ? scriptRuns.get(paragraph.ref) : undefined;
    if (includeTextFeatures && automaticMarkers && pageNumberControls && scriptRuns && (!scripts || scripts.length !== paragraph.runs.length)) throw new StyleError('corrupted', 'Missing script-run observation.');
    const node = measureText(paragraph, text, container, snapshot, includeTextFeatures, scripts);
    if (scripts) node.scriptRuns = [...scripts];
    if (node.textLength !== paragraph.textCodePoints) throw new StyleError('corrupted', 'Semantic text length differs from snapshot.');
    if (includeTextFeatures) {
      try { node.textFeatures = textFeatures(text); }
      catch (error) { if (error instanceof RangeError) throw new StyleError('too_large', 'Text features exceed input limit.'); throw error; }
      guard.check();
    }
    if (includeTextFeatures && automaticMarkers) {
      const marker = automaticMarkers.get(paragraph.ref);
      if (!marker) throw new StyleError('corrupted', 'Missing automatic marker observation.');
      node.automaticMarker = { ...marker };
    } else if (includeTextFeatures && snapshot.source.format === 'hwp5') node.automaticMarker = unknownAutomaticMarker('unsupported_format');
    size += Buffer.byteLength(JSON.stringify(node)) + 1;
    if (size > byteLimit) throw new StyleError('too_large', 'Semantic analysis evidence exceeds its byte limit.');
    nodes.push(node);
  }
  const automatic = includeTextFeatures && (!!automaticMarkers || snapshot.source.format === 'hwp5');
  const result: SemanticEvidence = { schema: automatic ? automaticMarkers ? pageNumberControls ? scriptRuns ? 'report-style-semantic-evidence/0.8' : 'report-style-semantic-evidence/0.7' : 'report-style-semantic-evidence/0.6' : 'report-style-semantic-evidence/0.5' : includeTextFeatures ? 'report-style-semantic-evidence/0.2' : 'report-style-semantic-evidence/0.1', ruleSetVersion: automatic ? automaticMarkers ? pageNumberControls && scriptRuns ? 'ko-structure/0.10' : 'ko-structure/0.9' : 'ko-structure/0.8' : includeTextFeatures ? 'ko-structure/0.5' : 'ko-structure/0.4', ...(includeTextFeatures ? { textFeaturesVersion: TEXT_FEATURES_VERSION } : {}), measurementSha256: canonicalDigest(snapshot), ...(automatic && automaticMarkers && pageNumberControls ? { pageNumberControls } : {}), nodes };
  if (Buffer.byteLength(JSON.stringify(result)) > byteLimit) throw new StyleError('too_large', 'Semantic analysis evidence exceeds its byte limit.');
  return result;
}

/** Reject free text, unbound measurements, invalid references and ranges. */
export function validateSemanticEvidence(snapshot: StyleSnapshot, input: unknown, byteLimit = LIMITS.snapshot, snapshotLimit: number = LIMITS.snapshot): SemanticEvidence {
  validateSnapshot(snapshot, snapshotLimit);
  const copy = copyBoundedJson(input, byteLimit);
  if (!validate(copy)) throw new StyleError('corrupted', `Invalid semantic evidence: ${JSON.stringify(validate.errors)}`);
  const evidence = copy as SemanticEvidence;
  if (evidence.pageNumberControls) {
    const sections = snapshot.sections.map(section => section.ref), keys = Object.keys(evidence.pageNumberControls);
    if (keys.length !== sections.length || sections.some(ref => !Object.prototype.hasOwnProperty.call(evidence.pageNumberControls, ref)) || (snapshot.source.format === 'hwp5' && keys.some(ref => evidence.pageNumberControls![ref].state !== 'unknown'))) throw new StyleError('corrupted', 'Invalid page-number control binding.');
  }
  if (evidence.measurementSha256 !== canonicalDigest(snapshot) || evidence.nodes.length !== snapshot.paragraphs.length) throw new StyleError('corrupted', 'Semantic evidence measurement mismatch.');
  const ranks: Record<TextEvidence['prefix'], number | null> = { NONE: null, ROMAN: 1, ARABIC_DOT: 2, KOREAN_DOT: 3, ARABIC_PAREN: 4, KOREAN_PAREN: 5, BOTH_PAREN: 6, CIRCLED: 7, SYMBOL: 8 };
  const refs = new Map(snapshot.nodes.map(node => [node.ref, node]));
  const seriesKinds = new Map<string, string>();
  const ruleClasses: Record<string, string> = { cell_leading_short_distinct_run: 'INLINE_TABLE_HEADER', distinct_run_not_role: 'unknown', unit_keyword: 'UNIT', reference_keyword: 'REFERENCE', qualifier_keyword: 'QUALIFIER', korean_term_latin_abbreviation: 'ABBREVIATION', bracket_number: 'CITATION_MARKER', superscript_numeric: 'CITATION_MARKER', script_not_role: 'unknown', date_in_delimiters: 'DATE_PERIOD', annotation_marker: 'ANNOTATION', unclassified_delimited: 'unknown' };
  for (const [index, node] of evidence.nodes.entries()) {
    const paragraph = snapshot.paragraphs[index];
    if (node.automaticMarker?.state === 'measured' && node.automaticMarker.series) {
      const prior = seriesKinds.get(node.automaticMarker.series);
      if (prior && prior !== node.automaticMarker.kind) throw new StyleError('corrupted', 'Conflicting automatic marker series.');
      seriesKinds.set(node.automaticMarker.series, node.automaticMarker.kind);
    }
    const discourseOrder = cues.map(([role]) => role);
    if (node.ref !== paragraph.ref || node.textLength !== paragraph.textCodePoints || node.prefixRank !== ranks[node.prefix] || node.wordCount > node.textLength ||
        (node.automaticMarker && (snapshot.source.format === 'hwp5' && !['ko-structure/0.9', 'ko-structure/0.10'].includes(evidence.ruleSetVersion) ? node.automaticMarker.state !== 'unavailable' || node.automaticMarker.reason !== 'unsupported_format' : node.automaticMarker.state === 'unavailable' && node.automaticMarker.reason === 'unsupported_format')) ||
        (node.scriptRuns && node.scriptRuns.length !== paragraph.runs.length) ||
        (node.textFeatures && !validTextFeatureBinding(node.textFeatures, node.textLength, node.rawNonempty)) ||
        (!node.rawNonempty && (node.contentNonempty || node.prefix !== 'NONE' || node.note || node.dateRaw || node.spans.length > 0)) ||
        (!node.contentNonempty && (node.wordCount !== 0 || node.ending !== 'empty' || node.caption || node.titleTerm || node.notice || node.organization || node.dateContent || node.discourse.length > 0)) ||
        (node.contentNonempty && node.wordCount === 0) ||
        (node.prefix === 'CIRCLED' && !node.prefixBullet) ||
        (!['CIRCLED', 'SYMBOL'].includes(node.prefix) && node.prefixBullet) ||
        node.discourse.some((item, i) => i > 0 && discourseOrder.indexOf(item.role) <= discourseOrder.indexOf(node.discourse[i - 1].role))) throw new StyleError('corrupted', 'Invalid semantic evidence node.');
    const roles = paragraph.candidates.map(candidate => candidate.role);
    let container: SemanticContainer = roles.includes('FOOTNOTE') ? 'footnote' : roles.includes('CAPTION') ? 'caption' : 'body';
    let parent = refs.get(paragraph.ref)?.parentRef ?? null;
    while (parent) {
      const ref = refs.get(parent);
      if (!ref) throw new StyleError('corrupted', 'Invalid semantic parent reference.');
      if (ref.kind === 'cell' && container === 'body') container = 'cell';
      if (ref.kind === 'header' || ref.kind === 'footer') { container = ref.kind; break; }
      parent = ref.parentRef;
    }
    if (node.spanCoverage === 'partial' && node.spans.length !== 32) throw new StyleError('corrupted', 'Invalid partial span coverage.');
    const keys = new Set<string>();
    let prior: TextEvidence['spans'][number] | undefined;
    for (const span of node.spans) {
      const key = `${span.start}:${span.length}:${span.shape}`;
      const isScript = span.shape === 'superscript' || span.shape === 'subscript';
      if (!Number.isSafeInteger(span.start + span.length) || span.start + span.length > node.textLength || keys.has(key) ||
          (prior && (span.start < prior.start || (span.start === prior.start && (span.length < prior.length || (span.length === prior.length && span.shape < prior.shape))))) ||
          (span.shape === 'distinct_run' && container !== 'cell') ||
          (isScript && (!node.scriptRuns || !scriptSpanBound(paragraph.runs, node.scriptRuns, span) || !span.classCandidates.some(candidate => candidate.rule === 'script_not_role'))) ||
          new Set(span.classCandidates.map(candidate => candidate.class)).size !== span.classCandidates.length ||
          span.classCandidates.some(candidate => ruleClasses[candidate.rule] !== candidate.class || (isScript
            ? !['script_not_role', ...(span.shape === 'superscript' ? ['superscript_numeric'] : [])].includes(candidate.rule)
            : span.shape === 'distinct_run'
            ? !['cell_leading_short_distinct_run', 'distinct_run_not_role'].includes(candidate.rule)
            : ['cell_leading_short_distinct_run', 'distinct_run_not_role', 'script_not_role', 'superscript_numeric'].includes(candidate.rule) || (candidate.rule === 'bracket_number' && span.shape !== 'bracket') || (candidate.rule === 'korean_term_latin_abbreviation' && span.shape !== 'paren'))) ||
          (span.classCandidates.some(candidate => candidate.class === 'INLINE_TABLE_HEADER') && !span.classCandidates.some(candidate => candidate.class === 'unknown'))) throw new StyleError('corrupted', 'Invalid semantic evidence span.');
      keys.add(key); prior = span;
    }
  }
  return evidence;
}
