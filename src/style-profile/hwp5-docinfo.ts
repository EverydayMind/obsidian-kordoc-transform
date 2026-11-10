import type { Atom, CharacterStyle, ParagraphStyle, LineSpacing } from './types';
import type { Record as HwpRecord } from './hwp5-records';
import { atom, missing, languageRecord, languages } from './normalize';
import { LIMITS, StyleError } from './limits';
import type { ScriptState } from './script-runs';

/** Independent measurement reader; never uses engine IR defaults or names. */
export class Hwp5Styles {
  private chars: HwpRecord[] = []; private paras: HwpRecord[] = [];
  private faces: string[][] = languages.map(() => []);
  readonly styles: Array<{ para: number; char: number }> = [];
  constructor(records: HwpRecord[]) {
    const mapping = records.find(record => record.tag === 17)?.data;
    const counts = languages.map((_, index) => mapping && mapping.length >= 8 + index * 4 ? mapping.readUInt32LE(4 + index * 4) : 0);
    let faceIndex = 0;
    for (const record of records) {
      const data = record.data;
      if (record.tag === 19) {
        let language = 0, index = faceIndex++;
        while (language < 7 && index >= counts[language]) index -= counts[language++];
        if (language >= 7 || data.length < 3) continue;
        const length = data.readUInt16LE(1);
        if (3 + length * 2 > data.length) throw new StyleError('corrupted', 'Truncated HWP font name.');
        this.faces[language].push(data.subarray(3, 3 + length * 2).toString('utf16le').normalize('NFC').trim());
      } else if (record.tag === 21) this.chars.push(record);
      else if (record.tag === 25) this.paras.push(record);
      else if (record.tag === 26) {
        let offset = 0;
        for (let index = 0; index < 2; index++) { if (offset + 2 > data.length) throw new StyleError('corrupted', 'Truncated HWP style.'); const length = data.readUInt16LE(offset); offset += 2 + length * 2; }
        if (offset + 8 > data.length) throw new StyleError('corrupted', 'Truncated HWP style references.');
        this.styles.push({ para: data.readUInt16LE(offset + 4), char: data.readUInt16LE(offset + 6) });
      }
      if (this.chars.length > LIMITS.styles || this.paras.length > LIMITS.styles || this.styles.length > LIMITS.styles || faceIndex > LIMITS.styles * 7) throw new StyleError('too_large', 'HWP style definition limit.');
    }
  }
  script(id: number): ScriptState {
    const data = this.chars[id]?.data;
    if (!data || data.length < 50) return 'unknown';
    const flags = data.readUInt32LE(46), above = !!(flags & (1 << 15)), below = !!(flags & (1 << 16));
    return above && below ? 'unknown' : above ? 'superscript' : below ? 'subscript' : 'normal';
  }
  character(id: number, inherited = false): CharacterStyle {
    const record = this.chars[id], data = record?.data, ref = `DocInfo/charShape/${id}`;
    const absent = <T>(): Atom<T> => missing(ref, record ? 'unsupported' : 'unresolved_reference');
    if (!data || data.length < 68) return { fonts: languageRecord(() => absent<string>()), sizePt: absent(), colorRgb: absent(), bold: absent(), italic: absent(), ratioPct: languageRecord(() => absent<number>()), spacingPct: languageRecord(() => absent<number>()) };
    const measured = <T>(value: T, raw: number | string | boolean, unit: string): Atom<T> => atom(value, raw, unit, ref, inherited ? 'inherited' : 'explicit');
    const fontSize = data.readUInt32LE(42), flags = data.readUInt32LE(46), color = data.readUInt32LE(52);
    const rgb = `#${[color & 255, color >>> 8 & 255, color >>> 16 & 255].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return { fonts: languageRecord(language => { const index = languages.indexOf(language), fontId = data.readUInt16LE(index * 2), name = this.faces[index][fontId]; return name === undefined ? missing(ref, 'unresolved_reference') : measured(name, fontId, 'font-id'); }), sizePt: measured(fontSize / 100, fontSize, 'HWPUNIT'), colorRgb: color === 0xffffffff ? missing(ref, 'unsupported') : measured(rgb, color, 'COLORREF'), bold: measured(!!(flags & 2), flags, 'bitfield'), italic: measured(!!(flags & 1), flags, 'bitfield'), ratioPct: languageRecord(language => measured(data.readUInt8(14 + languages.indexOf(language)), data.readUInt8(14 + languages.indexOf(language)), 'pct')), spacingPct: languageRecord(language => measured(data.readInt8(21 + languages.indexOf(language)), data.readInt8(21 + languages.indexOf(language)), 'pct')) };
  }
  paragraph(id: number): ParagraphStyle {
    const record = this.paras[id], data = record?.data, ref = `DocInfo/paraShape/${id}`;
    const absent = <T>(): Atom<T> => missing(ref, record ? 'unsupported' : 'unresolved_reference');
    if (!data || data.length < 28) return { align: absent(), leftPt: absent(), rightPt: absent(), firstLinePt: absent(), beforePt: absent(), afterPt: absent(), lineSpacing: absent(), pageBreakBefore: absent(), outlineLevel: absent() };
    const flags = data.readUInt32LE(0), alignment = (flags >>> 2) & 7;
    const alignments = ['justify', 'left', 'right', 'center', 'distribute', 'distribute'] as const;
    const length = (offset: number) => atom(data.readInt32LE(offset) / 100, data.readInt32LE(offset), 'HWPUNIT', ref);
    const lineKind = (flags & 3), rawLine = data.readInt32LE(24), kinds = ['percent', 'fixed', 'between', 'minimum'] as const;
    const lineSpacing = atom<LineSpacing>({ kind: kinds[lineKind], value: lineKind === 0 ? rawLine : rawLine / 100, unit: lineKind === 0 ? 'pct' : 'pt' }, rawLine, lineKind === 0 ? 'pct' : 'HWPUNIT', ref);
    return { align: alignments[alignment] ? atom(alignments[alignment], alignment, 'enum', ref) : missing(ref, 'unsupported'), leftPt: length(4), rightPt: length(8), firstLinePt: length(12), beforePt: length(16), afterPt: length(20), lineSpacing, pageBreakBefore: atom(!!(flags & (1 << 22)), flags, 'bitfield', ref), outlineLevel: atom(((flags >>> 23) & 3) === 1 ? ((flags >>> 25) & 7) + 1 : 0, flags, 'bitfield', ref) };
  }
}
