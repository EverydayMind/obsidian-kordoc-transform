import { children, descendants, is, NS, type Document, type Element } from './xml';

/** Text-free observation, separate from the immutable v1 measurement. */
export type AutomaticMarker =
  | { state: 'none' }
  | { state: 'unavailable'; reason: 'unsupported_format' | 'unresolved_reference' | 'unsupported_definition' }
  | { state: 'measured'; kind: 'number' | 'bullet'; level: number; format: 'digit' | 'hangul' | 'roman' | 'latin' | 'bullet' | 'other'; series?: string };

export const unknownAutomaticMarker = (reason: Extract<AutomaticMarker, { state: 'unavailable' }>['reason']): AutomaticMarker => ({ state: 'unavailable', reason });

function indexed(document: Document, name: string): Map<string, Element | null> {
  const result = new Map<string, Element | null>();
  for (const element of descendants(document, name, NS.head)) {
    const id = element.getAttribute('id');
    if (id !== null && id.length <= 10 && /^\d+$/.test(id)) result.set(id, result.has(id) ? null : element);
  }
  return result;
}

/** Resolve only the referenced definition; never copy its display text or IDs. */
export class HwpxNumbering {
  private readonly numbering: Map<string, Element | null>;
  private readonly bullets: Map<string, Element | null>;
  private readonly resolved = new Map<string, AutomaticMarker>();
  private readonly series = new Map<Element, string>();
  constructor(document: Document) {
    this.numbering = indexed(document, 'numbering');
    this.bullets = indexed(document, 'bullet');
    for (const definition of [...this.numbering.values(), ...this.bullets.values()])
      if (definition) this.series.set(definition, `n${this.series.size + 1}`);
  }
  observe(para: Element | undefined): AutomaticMarker {
    if (!para) return unknownAutomaticMarker('unresolved_reference');
    const headings = children(para).filter(node => is(node, 'heading', NS.head));
    if (headings.length !== 1) return unknownAutomaticMarker('unsupported_definition');
    const heading = headings[0], type = heading.getAttribute('type');
    if (type === 'NONE') return { state: 'none' };
    if (type !== 'NUMBER' && type !== 'BULLET') return unknownAutomaticMarker('unsupported_definition');
    const rawLevel = heading.getAttribute('level'), id = heading.getAttribute('idRef');
    if (rawLevel === null || !/^[0-8]$/.test(rawLevel) || id === null || id.length > 10 || !/^\d+$/.test(id)) return unknownAutomaticMarker('unsupported_definition');
    const level = Number(rawLevel) + 1;
    const key = `${type}:${id}:${level}`, cached = this.resolved.get(key);
    if (cached) return cached;
    const remember = (marker: AutomaticMarker): AutomaticMarker => { this.resolved.set(key, marker); return marker; };
    const definition = (type === 'NUMBER' ? this.numbering : this.bullets).get(id);
    if (!definition) return remember(unknownAutomaticMarker('unresolved_reference'));
    const series = this.series.get(definition);
    if (!series) return remember(unknownAutomaticMarker('unresolved_reference'));
    if (type === 'BULLET') return remember({ state: 'measured', kind: 'bullet', level, format: 'bullet', series });
    const levels = children(definition).filter(node => is(node, 'paraHead', NS.head) && node.getAttribute('level') === String(level));
    if (levels.length !== 1 || !levels[0].getAttribute('numFormat')) return remember(unknownAutomaticMarker('unsupported_definition'));
    const pattern = levels[0].textContent ?? '';
    if (pattern.length > 256 || !new RegExp(`\\^${level}(?!\\d)`).test(pattern)) return remember(unknownAutomaticMarker('unsupported_definition'));
    const rawFormat = levels[0].getAttribute('numFormat')!;
    const format = rawFormat === 'DIGIT' ? 'digit' : ['HANGUL_SYLLABLE', 'HANGUL_JAMO'].includes(rawFormat) ? 'hangul' : ['ROMAN_CAPITAL', 'ROMAN_SMALL'].includes(rawFormat) ? 'roman' : ['LATIN_CAPITAL', 'LATIN_SMALL'].includes(rawFormat) ? 'latin' : 'other';
    return remember({ state: 'measured', kind: 'number', level, format, series });
  }
}
