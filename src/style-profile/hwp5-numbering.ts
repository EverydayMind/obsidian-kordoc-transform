import type { Record as HwpRecord } from './hwp5-records';
import { LIMITS, StyleError } from './limits';
import { unknownAutomaticMarker, type AutomaticMarker } from './numbering';

/** HWP 5 DocInfo paragraph heads; source patterns and IDs never leave this reader. */
export class Hwp5Numbering {
  private readonly paragraphs: HwpRecord[];
  private readonly numbers: HwpRecord[];
  private readonly bullets: HwpRecord[];
  constructor(records: HwpRecord[]) {
    this.paragraphs = records.filter(record => record.tag === 25);
    this.numbers = records.filter(record => record.tag === 23);
    this.bullets = records.filter(record => record.tag === 24);
    if ([this.paragraphs, this.numbers, this.bullets].some(items => items.length > LIMITS.styles)) throw new StyleError('too_large', 'HWP numbering definition limit.');
  }

  observe(paragraphId: number): AutomaticMarker {
    const data = this.paragraphs[paragraphId]?.data;
    if (!data) return unknownAutomaticMarker('unresolved_reference');
    if (data.length < 4) return unknownAutomaticMarker('unsupported_definition');
    const flags = data.readUInt32LE(0), type = flags >>> 23 & 3, rawLevel = flags >>> 25 & 7;
    if (type === 0) return { state: 'none' };
    // Outline numbering needs the section's separate outline reference.
    if (type === 1 || rawLevel > 6 || data.length < 32) return unknownAutomaticMarker('unsupported_definition');
    const id = data.readUInt16LE(30), level = rawLevel + 1;
    const definition = (type === 2 ? this.numbers : this.bullets)[id - 1];
    if (!id || !definition) return unknownAutomaticMarker('unresolved_reference');
    const series = `n${type === 2 ? id : this.numbers.length + id}`;
    if (type === 3) {
      if (definition.data.length < 14 || !definition.data.readUInt16LE(12) || definition.data.readUInt16LE(12) === 0xffff) return unknownAutomaticMarker('unsupported_definition');
      return { state: 'measured', kind: 'bullet', level, format: 'bullet', series };
    }
    let offset = 0;
    for (let index = 0; index <= rawLevel; index++) {
      if (offset + 14 > definition.data.length) return unknownAutomaticMarker('unsupported_definition');
      const formatCode = definition.data.readUInt32LE(offset) >>> 5 & 15;
      const length = definition.data.readUInt16LE(offset + 12);
      offset += 14;
      if (length > 256 || offset + length * 2 > definition.data.length) return unknownAutomaticMarker('unsupported_definition');
      if (index === rawLevel) {
        const pattern = definition.data.subarray(offset, offset + length * 2).toString('utf16le');
        if (!new RegExp(`\\^${level}(?!\\d)`).test(pattern)) return unknownAutomaticMarker('unsupported_definition');
        const format = formatCode <= 1 ? 'digit' : formatCode <= 3 ? 'roman' : formatCode <= 7 ? 'latin' : formatCode <= 12 ? 'hangul' : 'other';
        return { state: 'measured', kind: 'number', level, format, series };
      }
      offset += length * 2;
    }
    return unknownAutomaticMarker('unsupported_definition');
  }
}
