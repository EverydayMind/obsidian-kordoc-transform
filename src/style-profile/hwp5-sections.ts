import type { StyleSnapshot, Paragraph, TableStyle, SectionStyle, Atom } from './types';
import type { Record as HwpRecord } from './hwp5-records';
import { visiblePrefix } from './prefix';
import { Hwp5Styles } from './hwp5-docinfo';
import { Hwp5Numbering } from './hwp5-numbering';
import { unknownAutomaticMarker, type AutomaticMarker } from './numbering';
import type { ScriptRuns, ScriptState } from './script-runs';
import { atom, missing, sideRecord } from './normalize';
import { References } from './refs';
import { Guard, LIMITS, StyleError } from './limits';

function intern<T>(table: T[], value: T, keys: Map<string, number>) { const key = JSON.stringify(value), previous = keys.get(key); if (previous !== undefined) return previous; if (table.length >= LIMITS.styles) throw new StyleError('too_large', 'Effective style budget.'); const index = table.push(value) - 1; keys.set(key, index); return index; }
function controlId(data: Buffer) { return data.length >= 4 ? Buffer.from(data.subarray(0, 4)).reverse().toString('ascii') : ''; }

/** Raw character positions include extended controls; map to Unicode code
 * points before producing runs. Text stays exclusively in inspect's map. */
function textAndOffsets(data: Buffer) {
  if (data.length % 2) throw new StyleError('corrupted', 'Odd HWP UTF-16 text length.');
  let text = '', points = 0; const offsets: number[] = [];
  for (let unit = 0; unit < data.length / 2;) {
    const code = data.readUInt16LE(unit * 2), start = unit; let count = 1, value = '';
    if (code >= 32) { count = code >= 0xd800 && code <= 0xdbff && unit + 1 < data.length / 2 && data.readUInt16LE((unit + 1) * 2) >= 0xdc00 && data.readUInt16LE((unit + 1) * 2) <= 0xdfff ? 2 : 1; value = data.subarray(unit * 2, (unit + count) * 2).toString('utf16le'); }
    else if (code === 9) { count = 8; value = '\t'; }
    else if (code === 10) value = '\n';
    else if (code === 24) value = '-';
    else if (code === 30 || code === 31) value = '\u00a0';
    else if (code > 0 && code < 24 && code !== 13) count = 8;
    if (unit + count > data.length / 2) throw new StyleError('corrupted', 'Truncated HWP inline control.');
    for (; unit < start + count; unit++) offsets[unit] = points;
    text += value; points += [...value].length;
  }
  offsets[data.length / 2] = points; return { text, offsets, points };
}

export async function measureHwp5Sections(streams: Array<HwpRecord[]>, styles: Hwp5Styles, snapshot: StyleSnapshot, guard: Guard, numbering?: Hwp5Numbering, automaticMarkers?: Map<string, AutomaticMarker>, scriptRuns?: ScriptRuns): Promise<Map<string, string>> {
  const texts = new Map<string, string>(), charKeys = new Map<string, number>(), paraKeys = new Map<string, number>();
  let totalRuns = 0, totalCells = 0;
  for (const [index, records] of streams.entries()) {
    const refs = new References(`s${index}`, snapshot.nodes);
    const page = records.find(record => record.tag === 73)?.data, columns = records.find(record => record.tag === 71 && controlId(record.data) === 'cold')?.data;
    const length = (offset: number): Atom<number> => page && page.length >= 40 ? atom(page.readUInt32LE(offset) / 100, page.readUInt32LE(offset), 'HWPUNIT', refs.section) : missing(refs.section);
    const margins = ['left', 'right', 'top', 'bottom', 'header', 'footer', 'gutter'] as const;
    const columnCount = columns && columns.length >= 6 ? columns.readUInt16LE(4) >>> 2 & 255 : 0;
    snapshot.sections.push({ ref: refs.section, widthPt: length(0), heightPt: length(4), orientation: page && page.length >= 40 ? atom(page.readUInt32LE(36) & 1 ? 'landscape' : 'portrait', page.readUInt32LE(36), 'bitfield', refs.section) : missing(refs.section), marginsPt: Object.fromEntries(margins.map((side, i) => [side, length(8 + i * 4)])) as SectionStyle['marginsPt'], columns: columnCount ? atom(columnCount, columns!.readUInt16LE(4), 'bitfield', refs.section) : missing(refs.section) });
    const stack: Array<{ level: number; ref: string; kind: string; paragraph?: Paragraph; table?: TableStyle; rawText?: Buffer[]; shapes?: Array<{ position: number; id: number }> }> = [];
    const finish = (entry: typeof stack[number]) => {
      if (!entry.paragraph) return;
      const raw = Buffer.concat(entry.rawText ?? []), decoded = textAndOffsets(raw), p = entry.paragraph;
      texts.set(p.ref, decoded.text); p.prefix = visiblePrefix(decoded.text);
      if (p.prefix) p.candidates.push({ role: 'prefix', rule: 'visible_numbering_or_bullet_token', evidenceRefs: [p.ref] });
      p.textCodePoints = decoded.points;
      const shapes = entry.shapes?.length ? entry.shapes : [{ position: 0, id: styles.styles[Number(p.sourceStyleId)]?.char ?? -1 }];
      const scripts: ScriptState[] = []; scriptRuns?.set(p.ref, scripts);
      for (let index = 0; index < shapes.length; index++) {
        const shape = shapes[index], next = shapes[index + 1]?.position ?? raw.length / 2;
        if (shape.position > next || shape.position > raw.length / 2 || next > raw.length / 2 || (index && shape.position <= shapes[index - 1].position)) throw new StyleError('corrupted', 'HWP character run boundary.');
        if (++totalRuns > LIMITS.runs) throw new StyleError('too_large', 'HWP run budget.');
        scripts.push(styles.script(shape.id));
        p.runs.push({ start: decoded.offsets[shape.position] ?? 0, length: (decoded.offsets[next] ?? decoded.points) - (decoded.offsets[shape.position] ?? 0), characterStyle: intern(snapshot.characterStyles, styles.character(shape.id, !entry.shapes?.length), charKeys) });
      }
    };
    for (const record of records) {
      await guard.tick();
      while (stack.length && stack[stack.length - 1].level >= record.level) {
        const top = stack[stack.length - 1];
        // HWP cell LIST_HEADER and its PARA_HEADER siblings can have the same
        // level. Keep the cell until the next list header/control boundary.
        if (top.kind === 'cell' && record.tag === 66 && top.level === record.level) break;
        finish(stack.pop()!);
      }
      const parent = stack[stack.length - 1], paragraphEntry = [...stack].reverse().find(entry => entry.paragraph), tableEntry = [...stack].reverse().find(entry => entry.table);
      const data = record.data;
      if (record.tag === 66) {
        if (data.length < 12) throw new StyleError('corrupted', 'Truncated HWP paragraph header.');
        if (snapshot.paragraphs.length >= LIMITS.paragraphs) throw new StyleError('too_large', 'HWP paragraph budget.');
        const ref = refs.add('paragraph', parent?.ref ?? null), paraId = data.readUInt16LE(8), style = styles.paragraph(paraId);
        if (numbering && automaticMarkers) automaticMarkers.set(ref, numbering.observe(paraId));
        const p: Paragraph = { ref, sourceStyleId: String(data[10]), paragraphStyle: intern(snapshot.paragraphStyles, style, paraKeys), textCodePoints: 0, runs: [], prefix: null, candidates: [] };
        if (style.outlineLevel.state === 'measured' && style.outlineLevel.value > 0) p.candidates.push({ role: `H${style.outlineLevel.value}`, rule: 'explicit_outline_level', evidenceRefs: [style.outlineLevel.evidenceRef] });
        if (parent?.kind === 'cell') p.candidates.push({ role: 'CELL_BODY', rule: 'explicit_hwp_cell', evidenceRefs: [ref] });
        snapshot.paragraphs.push(p);
        if (parent?.kind === 'cell') tableEntry?.table?.cells.find(cell => cell.ref === parent.ref)?.paragraphRefs.push(ref);
        stack.push({ level: record.level, ref, kind: 'paragraph', paragraph: p, rawText: [], shapes: [] });
      } else if (record.tag === 67 && paragraphEntry && record.level === paragraphEntry.level + 1) paragraphEntry.rawText!.push(data);
      else if (record.tag === 68 && paragraphEntry && record.level === paragraphEntry.level + 1) { if (data.length % 8) throw new StyleError('corrupted', 'Invalid HWP character shape positions.'); for (let offset = 0; offset < data.length; offset += 8) paragraphEntry.shapes!.push({ position: data.readUInt32LE(offset), id: data.readUInt32LE(offset + 4) }); }
      else if (record.tag === 71) {
        const id = controlId(Buffer.from(data)), kind = id === 'tbl ' ? 'table' : id === 'head' ? 'header' : id === 'foot' ? 'footer' : null;
        if (id === 'nwno' && parent?.paragraph && automaticMarkers?.get(parent.ref)?.state === 'measured') automaticMarkers.set(parent.ref, unknownAutomaticMarker('unsupported_definition'));
        if (kind) {
          const ref = refs.add(kind, parent?.ref ?? null);
          let table: TableStyle | undefined;
          if (kind === 'table') { if (snapshot.tables.length >= LIMITS.tables) throw new StyleError('too_large', 'HWP table budget.'); table = { ref, rowCount: 0, columnCount: 0, columnRatios: missing(ref), cells: [] }; snapshot.tables.push(table); }
          stack.push({ level: record.level, ref, kind, table });
        } else if (parent && !['secd', 'cold', 'pgnp', 'atno', 'nwno'].includes(id)) snapshot.unsupported.push({ feature: `hwp-control-${id.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'unknown'}`, refs: [parent.ref] });
      } else if (record.tag === 77 && tableEntry?.table) {
        if (data.length < 8) throw new StyleError('corrupted', 'Truncated HWP table.');
        tableEntry.table.rowCount = data.readUInt16LE(4); tableEntry.table.columnCount = data.readUInt16LE(6);
      } else if (record.tag === 72 && parent?.table && data.length >= 34) {
        const table = parent.table, row = data.readUInt16LE(10), column = data.readUInt16LE(8), ref = refs.add('cell', table.ref, `${row}.${column}`);
        if (++totalCells > LIMITS.cells) throw new StyleError('too_large', 'HWP cell budget.');
        table.cells.push({ ref, row, column, rowSpan: data.readUInt16LE(14), columnSpan: data.readUInt16LE(12), borders: sideRecord(() => missing(ref, 'unsupported')), fillRgb: missing(ref, 'unsupported'), paddingPt: sideRecord(side => { const offset = 24 + ['left', 'right', 'top', 'bottom'].indexOf(side) * 2; return atom(data.readUInt16LE(offset) / 100, data.readUInt16LE(offset), 'HWPUNIT', ref); }), paragraphRefs: [] });
        stack.push({ level: record.level, ref, kind: 'cell' });
      }
    }
    while (stack.length) finish(stack.pop()!);
  }
  // Nested paragraphs finish before their containing paragraph. Re-index run
  // styles by paragraph preorder, rather than by control-stack completion.
  const previous = snapshot.characterStyles.slice(), remap = new Map<number, number>();
  snapshot.characterStyles = [];
  for (const paragraph of snapshot.paragraphs) for (const run of paragraph.runs) {
    const old = run.characterStyle;
    let index = remap.get(old);
    if (index === undefined) { index = snapshot.characterStyles.push(previous[old]) - 1; remap.set(old, index); }
    run.characterStyle = index;
  }
  return texts;
}
