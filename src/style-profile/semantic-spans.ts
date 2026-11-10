import type { CharacterStyle, Paragraph, Atom } from './types';
import type { ScriptState } from './script-runs';

export type SpanClass = 'UNIT' | 'REFERENCE' | 'QUALIFIER' | 'ABBREVIATION' | 'CITATION_MARKER' | 'DATE_PERIOD' | 'ANNOTATION' | 'INLINE_TABLE_HEADER' | 'unknown';
export type SemanticSpan = {
  start: number; length: number;
  shape: 'paren' | 'bracket' | 'angle' | 'distinct_run' | 'superscript' | 'subscript';
  attaches: 'previous' | 'paragraph' | 'unknown';
  classCandidates: Array<{ class: SpanClass; rule: string }>;
};
export type SpanResult = { spans: SemanticSpan[]; spanCoverage: 'complete' | 'partial' };

const MAX_SPANS = 32;
const pairs = /\([^()\r\n]{1,100}\)|\[[^[\]\r\n]{1,100}\]|<[^<>\r\n]{1,100}>/gu;
const nounLabel = (value: string) => value.length <= 64 && value.trim().split(/\s+/u).length <= 4 && !/[.!?。！？]$/u.test(value.trim()) && !/(?:다|니다|한다|된다|있다|없다|합니다)$/u.test(value.trim());
function countPoints(text: string, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++, count++) {
    const point = text.codePointAt(i)!;
    if (point > 0xffff && i + 1 < end) i++;
  }
  return count;
}

/** A style index is an identity, not evidence that two styles look different. */
export function measuredStyleDifference(styles: CharacterStyle[], left: number, right: number): boolean | null {
  const a = styles[left], b = styles[right];
  if (!a || !b || a.bold.state !== 'measured' || b.bold.state !== 'measured' ||
      a.italic.state !== 'measured' || b.italic.state !== 'measured') return null;
  if (left === right) return false;
  const different = <T>(x: Atom<T>, y: Atom<T>) => x.state === 'measured' && y.state === 'measured' && x.value !== y.value;
  if (different(a.bold, b.bold) || different(a.italic, b.italic) || different(a.sizePt, b.sizePt) ||
      different(a.colorRgb, b.colorRgb) ||
      (Object.keys(a.fonts) as Array<keyof CharacterStyle['fonts']>).some(language => {
        const x = a.fonts[language], y = b.fonts[language];
        return x.state === 'measured' && y.state === 'measured' && !!x.value && !!y.value && x.value !== y.value;
      }) ||
      (Object.keys(a.ratioPct) as Array<keyof CharacterStyle['ratioPct']>).some(language =>
        different(a.ratioPct[language], b.ratioPct[language]) || different(a.spacingPct[language], b.spacingPct[language]))) return true;
  return null;
}

/** Returns fixed candidate labels and code-point ranges, never the source text. */
export function inferSpans(paragraph: Paragraph, text: string, inCell: boolean,
  different: (left: number, right: number) => boolean | null = (left, right) => left !== right, scripts?: readonly ScriptState[]): SpanResult {
  const spans: SemanticSpan[] = [];
  let partial = false;
  const add = (span: SemanticSpan) => { if (spans.length < MAX_SPANS) spans.push(span); else partial = true; };
  if (inCell && paragraph.runs.length > 1) {
    // Examine only the leading bounded context; run offsets are already Unicode code points.
    const points = [...text.slice(0, 1024)];
    const firstText = points.findIndex(point => !/\s/u.test(point));
    const firstRun = paragraph.runs.findIndex(run => run.start <= firstText && firstText < run.start + run.length);
    if (firstText >= 0 && firstText <= 3 && firstRun >= 0) {
      const initial = paragraph.runs[firstRun];
      let end = initial.start + initial.length;
      let next = firstRun + 1;
      while (next < paragraph.runs.length && paragraph.runs[next].start === end && different(paragraph.runs[next].characterStyle, initial.characterStyle) === false) {
        end += paragraph.runs[next].length; next++;
      }
      if (end <= 128 && next < paragraph.runs.length && points.length > end) {
        let labelEnd = end;
        while (labelEnd > firstText && /\s/u.test(points[labelEnd - 1])) labelEnd--;
        let valueStart = end;
        while (valueStart < points.length && /\s/u.test(points[valueStart])) valueStart++;
        const valueRun = paragraph.runs.find(run => run.start <= valueStart && valueStart < run.start + run.length);
        const label = points.slice(firstText, labelEnd).join('');
        if (label && valueStart < points.length && valueRun && different(valueRun.characterStyle, initial.characterStyle) === true) {
          const classes: SemanticSpan['classCandidates'] = [];
          if (nounLabel(label)) classes.push({ class: 'INLINE_TABLE_HEADER', rule: 'cell_leading_short_distinct_run' });
          classes.push({ class: 'unknown', rule: 'distinct_run_not_role' });
          add({ start: firstText, length: labelEnd - firstText, shape: 'distinct_run', attaches: 'unknown', classCandidates: classes });
        }
      }
    }
  }
  let scannedUtf16 = 0, codePointOffset = 0;
  for (const match of text.matchAll(pairs)) {
    const index = match.index;
    codePointOffset += countPoints(text, scannedUtf16, index);
    const start = codePointOffset, token = match[0], length = [...token].length;
    scannedUtf16 = index + token.length; codePointOffset += length;
    const inner = token.slice(1, -1).trim();
    const classes: SemanticSpan['classCandidates'] = [];
    if (/단위/u.test(inner)) classes.push({ class: 'UNIT', rule: 'unit_keyword' });
    if (/별첨|붙임|참조|참고/u.test(inner)) classes.push({ class: 'REFERENCE', rule: 'reference_keyword' });
    if (/잠정|가칭|초안|예정|^안$/u.test(inner)) classes.push({ class: 'QUALIFIER', rule: 'qualifier_keyword' });
    if (token.startsWith('(') && /^[A-Z][A-Z0-9]{1,11}$/u.test(inner) && /[가-힣]\s*$/u.test(text.slice(Math.max(0, index - 8), index))) classes.push({ class: 'ABBREVIATION', rule: 'korean_term_latin_abbreviation' });
    if (token.startsWith('[') && /^\d{1,4}$/u.test(inner)) classes.push({ class: 'CITATION_MARKER', rule: 'bracket_number' });
    if (/\d{4}\s*(?:년|[./-])\s*\d{1,2}/u.test(inner)) classes.push({ class: 'DATE_PERIOD', rule: 'date_in_delimiters' });
    if (/^[※*]/u.test(inner)) classes.push({ class: 'ANNOTATION', rule: 'annotation_marker' });
    if (!classes.length) classes.push({ class: 'unknown', rule: 'unclassified_delimited' });
    add({ start, length, shape: token[0] === '(' ? 'paren' : token[0] === '[' ? 'bracket' : 'angle', attaches: start > 0 && /\S/u.test(text.slice(Math.max(0, index - 1), index)) ? 'previous' : 'unknown', classCandidates: classes });
    if (partial) break;
  }
  if (scripts?.some(script => script === 'superscript' || script === 'subscript')) {
    const points = [...text];
    for (let index = 0; index < paragraph.runs.length && !partial; index++) {
      const script = scripts[index];
      if (script !== 'superscript' && script !== 'subscript') continue;
      let start = paragraph.runs[index].start, end = start + paragraph.runs[index].length;
      while (index + 1 < paragraph.runs.length && scripts[index + 1] === script && paragraph.runs[index + 1].start === end) {
        index++; end += paragraph.runs[index].length;
      }
      while (start < end && /\s/u.test(points[start])) start++;
      while (end > start && /\s/u.test(points[end - 1])) end--;
      if (start === end) continue;
      const classes: SemanticSpan['classCandidates'] = [];
      if (script === 'superscript' && /^\d{1,4}$/u.test(points.slice(start, end).join(''))) classes.push({ class: 'CITATION_MARKER', rule: 'superscript_numeric' });
      classes.push({ class: 'unknown', rule: 'script_not_role' });
      add({ start, length: end - start, shape: script, attaches: start > 0 && /\S/u.test(points[start - 1]) ? 'previous' : 'unknown', classCandidates: classes });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.length - b.length || (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0));
  return { spans, spanCoverage: partial ? 'partial' : 'complete' };
}
