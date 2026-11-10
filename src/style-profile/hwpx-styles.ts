import type { CharacterStyle, ParagraphStyle, Atom, LineSpacing } from './types';
import { atom, missing, numberAtom, colorAtom, languageRecord } from './normalize';
import { children, first, descendants, is, NS, type Element, type Document } from './xml';
import { LIMITS, StyleError } from './limits';
import type { ScriptState } from './script-runs';

export class HwpxStyles {
  readonly chars = new Map<string, Element>(); readonly paras = new Map<string, Element>(); readonly styles = new Map<string, Element>(); readonly borders = new Map<string, Element>();
  private fonts = new Map<string, string>();
  private scripts = new Map<string, ScriptState>();
  constructor(document: Document) {
    for (const [tag, map] of [['charPr', this.chars], ['paraPr', this.paras], ['style', this.styles], ['borderFill', this.borders]] as const) {
      const definitions = descendants(document, tag, NS.head);
      if (definitions.length > LIMITS.styles) throw new StyleError('too_large', 'Style definition limit.');
      for (const node of definitions) { const id = node.getAttribute('id'); if (id === null || !/^[0-9]+$/.test(id) || map.has(id)) throw new StyleError('corrupted', 'Missing/duplicate style ID.'); map.set(id, node); }
    }
    for (const face of descendants(document, 'fontface', NS.head)) for (const font of children(face).filter(node => is(node, 'font', NS.head))) {
      const fontId = font.getAttribute('id'); if (!fontId || !/^[0-9]+$/.test(fontId)) throw new StyleError('corrupted', 'Invalid font definition ID.');
      const key = `${face.getAttribute('lang')?.toLowerCase()}/${fontId}`;
      if (this.fonts.has(key)) throw new StyleError('corrupted', 'Duplicate font ID.');
      this.fonts.set(key, (font.getAttribute('face') ?? '').normalize('NFC').trim());
    }
  }
  effectiveId(node: Element, attribute: string, sourceStyleId: string | null): { id: string; inherited: boolean } {
    const direct = node.getAttribute(attribute);
    if (direct !== null && !/^[0-9]+$/.test(direct)) throw new StyleError('corrupted', 'Invalid style reference ID.');
    return direct !== null ? { id: direct, inherited: false } : { id: this.styles.get(sourceStyleId ?? '')?.getAttribute(attribute) ?? 'unresolved', inherited: true };
  }
  script(id: string): ScriptState {
    const node = this.chars.get(id);
    const cached = this.scripts.get(id); if (cached) return cached;
    const remember = (state: ScriptState) => { this.scripts.set(id, state); return state; };
    if (!node || Array.from(node.attributes ?? []).some(attribute => ['supscript', 'superscript', 'subscript'].includes(attribute.localName ?? ''))) return remember('unknown');
    const pending = children(node), direct: Element[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (['supscript', 'superscript', 'subscript'].includes(current.localName ?? '')) {
        if (current.parentNode !== node || current.namespaceURI !== NS.head || current.localName === 'superscript') return remember('unknown');
        direct.push(current);
      }
      for (const child of children(current)) pending.push(child);
    }
    const supers = direct.filter(child => is(child, 'supscript', NS.head)), subs = direct.filter(child => is(child, 'subscript', NS.head));
    if (supers.length > 1 || subs.length > 1 || (supers.length && subs.length)) return remember('unknown');
    return remember(supers.length ? 'superscript' : subs.length ? 'subscript' : 'normal');
  }
  character(id: string, inherited = false): CharacterStyle {
    const node = this.chars.get(id), ref = `header/charPr/${id}`;
    const absent = <T>(): Atom<T> => missing(ref, 'unresolved_reference');
    if (!node) return { fonts: languageRecord(() => absent<string>()), sizePt: absent(), colorRgb: absent(), bold: absent(), italic: absent(), ratioPct: languageRecord(() => absent<number>()), spacingPct: languageRecord(() => absent<number>()) };
    const font = first(node, 'fontRef', NS.head), ratio = first(node, 'ratio', NS.head), spacing = first(node, 'spacing', NS.head);
    const result: CharacterStyle = { fonts: languageRecord(language => { const key = font?.getAttribute(language); const value = key === null || key === undefined ? undefined : this.fonts.get(`${language}/${key}`); return value === undefined ? missing(ref, 'unresolved_reference') : atom(value, key!, 'font-id', ref); }), sizePt: numberAtom(node.getAttribute('height'), ref, 100), colorRgb: colorAtom(node.getAttribute('textColor'), ref), bold: atom(!!first(node, 'bold', NS.head), !!first(node, 'bold', NS.head), 'boolean-element', ref), italic: atom(!!first(node, 'italic', NS.head), !!first(node, 'italic', NS.head), 'boolean-element', ref), ratioPct: languageRecord(language => numberAtom(ratio?.getAttribute(language), ref, 1, 'pct')), spacingPct: languageRecord(language => numberAtom(spacing?.getAttribute(language), ref, 1, 'pct')) };
    if (inherited) for (const value of [result.sizePt, result.colorRgb, result.bold, result.italic, ...Object.values(result.fonts), ...Object.values(result.ratioPct), ...Object.values(result.spacingPct)]) if (value.state === 'measured') value.origin = 'inherited';
    return result;
  }
  paragraph(id: string, inherited = false): ParagraphStyle {
    const node = this.paras.get(id), ref = `header/paraPr/${id}`;
    const absent = <T>(): Atom<T> => missing(ref, 'unresolved_reference');
    if (!node) return { align: absent(), leftPt: absent(), rightPt: absent(), firstLinePt: absent(), beforePt: absent(), afterPt: absent(), lineSpacing: absent(), pageBreakBefore: absent(), outlineLevel: absent() };
    // Prefer the explicit fallback branch; unimplemented namespace alternatives
    // are not mixed with fallback values from another branch.
    const branch = first(node, 'default', NS.para) ?? node;
    const margin = first(branch, 'margin', NS.head), spacing = first(branch, 'lineSpacing', NS.head), align = first(node, 'align', NS.head)?.getAttribute('horizontal')?.toLowerCase();
    const alignments: Record<string, 'left' | 'right' | 'center' | 'justify' | 'distribute'> = { left: 'left', right: 'right', center: 'center', justify: 'justify', distribute: 'distribute', distribute_space: 'distribute' };
    const lengths = (name: string) => { const value = first(margin, name, NS.core); const unit = value?.getAttribute('unit'); return unit === null || unit === undefined || unit === 'HWPUNIT' ? numberAtom(value?.getAttribute('value'), ref, 100) : unit === 'POINT' ? numberAtom(value?.getAttribute('value'), ref, 1, 'pt') : missing<number>(ref, 'unsupported'); };
    let lineSpacing: Atom<LineSpacing> = missing(ref);
    if (spacing) {
      const kind = ({ PERCENT: 'percent', FIXED: 'fixed', AT_LEAST: 'minimum', BETWEEN_LINES: 'between' } as const)[spacing.getAttribute('type') ?? ''];
      const value = numberAtom(spacing.getAttribute('value'), ref, kind === 'percent' ? 1 : 100);
      lineSpacing = kind && value.state === 'measured' ? atom({ kind, value: value.value, unit: kind === 'percent' ? 'pct' : 'pt' }, value.raw, kind === 'percent' ? 'pct' : 'HWPUNIT', ref) : missing(ref, 'unsupported');
    }
    const page = first(node, 'breakSetting', NS.head)?.getAttribute('pageBreakBefore'), heading = first(node, 'heading', NS.head);
    const headingType = heading?.getAttribute('type'), level = heading?.getAttribute('level');
    const result: ParagraphStyle = { align: align && alignments[align] ? atom(alignments[align], align, 'enum', ref) : missing(ref, align ? 'unsupported' : 'absent'), leftPt: lengths('left'), rightPt: lengths('right'), firstLinePt: lengths('intent'), beforePt: lengths('prev'), afterPt: lengths('next'), lineSpacing, pageBreakBefore: page === '0' || page === '1' ? atom(page === '1', page, 'boolean', ref) : missing(ref), outlineLevel: headingType === 'NONE' ? atom(0, headingType, 'outline', ref) : headingType === 'OUTLINE' && level !== null && level !== undefined && Number(level) >= 0 && Number(level) < 9 ? atom(Number(level) + 1, Number(level), 'zero-based', ref) : missing(ref, heading ? 'unsupported' : 'absent') };
    if (inherited) for (const value of Object.values(result)) if (value.state === 'measured') value.origin = 'inherited';
    return result;
  }
}
