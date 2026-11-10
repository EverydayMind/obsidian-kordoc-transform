import type { StyleSnapshot, SectionStyle, Paragraph, TableStyle, CharacterStyle, ParagraphStyle, Atom, Border } from './types';
import { atom, missing, numberAtom, colorAtom, sideRecord } from './normalize';
import { children, descendants, first, is, NS, parseXml, type Element } from './xml';
import { readBoundedZip } from './zip';
import { HwpxStyles } from './hwpx-styles';
import { visiblePrefix } from './prefix';
import { References } from './refs';
import { Guard, LIMITS, StyleError } from './limits';
import { HwpxNumbering, unknownAutomaticMarker, type AutomaticMarker } from './numbering';
import type { PageNumberControls } from './page-number-controls';
import type { ScriptRuns, ScriptState } from './script-runs';

function intern<T>(table: T[], keys: Map<string, number>, value: T): number {
  const key = JSON.stringify(value), previous = keys.get(key);
  if (previous !== undefined) return previous;
  if (table.length >= LIMITS.styles) throw new StyleError('too_large', 'Too many effective styles.');
  const index = table.push(value) - 1; keys.set(key, index); return index;
}
function sectionStyle(root: Element, ref: string): SectionStyle {
  const page = first(root, 'pagePr', NS.para), margin = first(page, 'margin', NS.para), columns = first(root, 'colPr', NS.para);
  const raw = page?.getAttribute('landscape');
  return { ref, widthPt: numberAtom(page?.getAttribute('width'), ref, 100), heightPt: numberAtom(page?.getAttribute('height'), ref, 100), orientation: raw === 'WIDELY' || raw === 'NARROWLY' ? atom(raw === 'WIDELY' ? 'portrait' : 'landscape', raw, 'landscape-enum', ref) : missing(ref, raw ? 'unsupported' : 'absent'), marginsPt: Object.fromEntries(['left', 'right', 'top', 'bottom', 'header', 'footer', 'gutter'].map(side => [side, numberAtom(margin?.getAttribute(side), ref, 100)])) as SectionStyle['marginsPt'], columns: numberAtom(columns?.getAttribute('colCount'), ref, 1, 'count') };
}

/** Text controls inside hp:t count as characters in the paragraph's offsets. */
function textRunContent(element: Element): string {
  let result = '';
  for (const child of Array.from(element.childNodes ?? [])) {
    if (child.nodeType === 3 || child.nodeType === 4) result += child.nodeValue ?? '';
    else if (child.nodeType === 1) {
      const nested = child as Element;
      if (is(nested, 'tab', NS.para)) result += '\t';
      else if (is(nested, 'lineBreak', NS.para)) result += '\n';
      else if (!['p', 'tbl', 'header', 'footer', 'footNote', 'endNote'].some(tag => is(nested, tag, NS.para))) result += textRunContent(nested);
    }
  }
  return result;
}

/** A numbering restart invalidates the inferred continuation for this paragraph. */
function hasOwnNumberRestart(element: Element): boolean {
  const pending = children(element);
  while (pending.length) {
    const node = pending.pop()!;
    if (is(node, 'newNum', NS.para)) return true;
    if (['p', 'tbl', 'header', 'footer', 'footNote', 'endNote'].some(tag => is(node, tag, NS.para))) continue;
    for (const child of children(node)) pending.push(child);
  }
  return false;
}

/** The text map exists only for inspect and is never part of a snapshot. */
export async function extractHwpx(bytes: Uint8Array, source: StyleSnapshot['source'], guard: Guard): Promise<{ snapshot: StyleSnapshot; texts: Map<string, string>; automaticMarkers: Map<string, AutomaticMarker>; pageNumberControls: PageNumberControls; scriptRuns: ScriptRuns }> {
  const zip = await readBoundedZip(bytes, guard);
  const headerBytes = zip.get('Contents/header.xml');
  let sectionNames = [...zip.keys()].filter(name => /^Contents\/section\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const packageBytes = zip.get('Contents/content.hpf');
  if (packageBytes) {
    const packageXml = await parseXml(packageBytes, guard), opf = 'http://www.idpf.org/2007/opf/';
    const items = new Map(descendants(packageXml, 'item', opf).map(item => [item.getAttribute('id'), item.getAttribute('href')]));
    const ordered = descendants(packageXml, 'itemref', opf).map(item => items.get(item.getAttribute('idref'))).filter((href): href is string => !!href && /(?:^|\/)section\d+\.xml$/.test(href)).map(href => href.startsWith('Contents/') ? href : `Contents/${href}`);
    if (ordered.length !== sectionNames.length || new Set(ordered).size !== ordered.length || ordered.some(name => !sectionNames.includes(name))) throw new StyleError('corrupted', 'Section spine mismatch.');
    sectionNames = ordered;
  }
  if (!headerBytes || !sectionNames.length || new TextDecoder().decode(zip.get('mimetype')) !== 'application/hwp+zip') throw new StyleError('unsupported', 'HWPX package required.');
  const header = await parseXml(headerBytes, guard);
  if (!header.documentElement || !is(header.documentElement, 'head', NS.head)) throw new StyleError('corrupted', 'Invalid HWPX header namespace.');
  const styles = new HwpxStyles(header);
  const numbering = new HwpxNumbering(header), automaticMarkers = new Map<string, AutomaticMarker>(), pageNumberControls: PageNumberControls = {}, scriptRuns: ScriptRuns = new Map();
  const snapshot: StyleSnapshot = { schema: 'report-style-snapshot/1', extractorVersion: 'kordoc-style/1.1', source, complete: true, sections: [], nodes: [], characterStyles: [], paragraphStyles: [], paragraphs: [], tables: [], unsupported: [], warnings: [] };
  const texts = new Map<string, string>(), characterKeys = new Map<string, number>(), paragraphKeys = new Map<string, number>();
  const tableCells = new WeakMap<TableStyle, Map<string, TableStyle['cells'][number]>>();
  let runCount = 0, cellCount = 0;
  const unsupported = (feature: string, ref: string) => { let item = snapshot.unsupported.find(item => item.feature === feature); if (!item) { item = { feature, refs: [] }; snapshot.unsupported.push(item); } item.refs.push(ref); };
  for (const [index, name] of sectionNames.entries()) {
    const doc = await parseXml(zip.get(name)!, guard), root = doc.documentElement!;
    if (!is(root, 'sec', NS.section)) throw new StyleError('corrupted', 'Invalid section namespace.');
    const refs = new References(`s${index}`, snapshot.nodes);
    snapshot.sections.push(sectionStyle(root, refs.section));
    let pageNumberCount = 0, pageNumberUnknown = false;
    const walk = async (element: Element, parent: string | null, currentTable?: TableStyle): Promise<void> => {
      await guard.tick();
      if (element.localName === 'pageNum') {
        const owner = element.parentNode as Element | null;
        if (is(element, 'pageNum', NS.para) && owner?.nodeType === 1 && is(owner, 'ctrl', NS.para)) pageNumberCount++;
        else pageNumberUnknown = true;
      }
      let ref = parent;
      if (is(element, 'p', NS.para)) {
        ref = refs.add('paragraph', parent);
        if (snapshot.paragraphs.length >= LIMITS.paragraphs) throw new StyleError('too_large', 'Paragraph budget.');
        const sourceStyleId = element.getAttribute('styleIDRef');
        if (sourceStyleId !== null && !/^[0-9]+$/.test(sourceStyleId)) throw new StyleError('corrupted', 'Invalid source style ID.');
        const paraId = styles.effectiveId(element, 'paraPrIDRef', sourceStyleId);
        const automatic = numbering.observe(styles.paras.get(paraId.id));
        automaticMarkers.set(ref, automatic.state === 'measured' && hasOwnNumberRestart(element) ? unknownAutomaticMarker('unsupported_definition') : automatic);
        const p: Paragraph = { ref, sourceStyleId, paragraphStyle: intern<ParagraphStyle>(snapshot.paragraphStyles, paragraphKeys, styles.paragraph(paraId.id, paraId.inherited)), textCodePoints: 0, runs: [], prefix: null, candidates: [] };
        const scripts: ScriptState[] = []; scriptRuns.set(ref, scripts);
        snapshot.paragraphs.push(p);
        let text = '';
        for (const run of children(element).filter(child => is(child, 'run', NS.para))) {
          const charId = styles.effectiveId(run, 'charPrIDRef', sourceStyleId), parts: string[] = [];
          scripts.push(styles.script(charId.id));
          const collectText = (node: Element) => { for (const child of children(node)) { if (['p', 'tbl', 'header', 'footer', 'footNote', 'endNote'].some(tag => is(child, tag, NS.para))) continue; if (is(child, 't', NS.para)) parts.push(textRunContent(child)); else if (is(child, 'tab', NS.para)) parts.push('\t'); else if (is(child, 'lineBreak', NS.para)) parts.push('\n'); else collectText(child); } };
          collectText(run);
          const runText = parts.join(''), length = [...runText].length;
          if (++runCount > LIMITS.runs) throw new StyleError('too_large', 'Run budget.');
          p.runs.push({ start: p.textCodePoints, length, characterStyle: intern<CharacterStyle>(snapshot.characterStyles, characterKeys, styles.character(charId.id, charId.inherited)) });
          p.textCodePoints += length; text += runText;
        }
        texts.set(ref, text);
        p.prefix = visiblePrefix(text);
        if (p.prefix) p.candidates.push({ role: 'prefix', rule: 'visible_numbering_or_bullet_token', evidenceRefs: [ref] });
        for (let context = element.parentNode; context?.nodeType === 1; context = context.parentNode) {
          const local = (context as Element).localName;
          const role = local === 'footNote' || local === 'endNote' ? 'FOOTNOTE' : local === 'caption' ? 'CAPTION' : local === 'tc' ? 'CELL_BODY' : null;
          if (role) { p.candidates.push({ role, rule: 'explicit_xml_container', evidenceRefs: [ref] }); break; }
        }

        const style = snapshot.paragraphStyles[p.paragraphStyle];
        if (style.outlineLevel.state === 'measured' && style.outlineLevel.value > 0) p.candidates.push({ role: `H${style.outlineLevel.value}`, rule: 'explicit_outline_level', evidenceRefs: [style.outlineLevel.evidenceRef] });
        if (parent && currentTable) tableCells.get(currentTable)?.get(parent)?.paragraphRefs.push(ref);
      } else if (is(element, 'tbl', NS.para)) {
        ref = refs.add('table', parent);
        if (snapshot.tables.length >= LIMITS.tables) throw new StyleError('too_large', 'Table budget.');
        const rowCount = Number(element.getAttribute('rowCnt')), columnCount = Number(element.getAttribute('colCnt'));
        if (!Number.isInteger(rowCount) || !Number.isInteger(columnCount) || rowCount < 1 || columnCount < 1 || rowCount * columnCount > LIMITS.cells) throw new StyleError('corrupted', 'Invalid table dimensions.');
        currentTable = { ref, rowCount, columnCount, columnRatios: missing(ref), cells: [] };
        tableCells.set(currentTable, new Map());
        snapshot.tables.push(currentTable);
      } else if (is(element, 'tc', NS.para)) {
        if (!currentTable) throw new StyleError('corrupted', 'Cell without table.');
        if (++cellCount > LIMITS.cells) throw new StyleError('too_large', 'Cell budget.');
        // A cell's subList may contain another table before these properties.
        // Descendant searches would then read the nested cell's coordinates.
        const properties = children(element);
        const property = (name: string) => properties.find(child => is(child, name, NS.para));
        const address = property('cellAddr'), span = property('cellSpan'), row = Number(address?.getAttribute('rowAddr')), column = Number(address?.getAttribute('colAddr'));
        if (!address || !span || !Number.isInteger(row) || !Number.isInteger(column)) throw new StyleError('corrupted', 'Missing cell address/span.');
        ref = refs.add('cell', currentTable.ref, `${row}.${column}`);
        const cellRef = ref;
        const borderRef = element.getAttribute('borderFillIDRef'), border = styles.borders.get(borderRef ?? ''), margin = property('cellMargin');
        const borderAtom = (side: string): Atom<Border> => {
          const value = first(border, `${side}Border`, NS.head), raw = value?.getAttribute('width'), match = raw?.match(/^([0-9.]+)\s*mm$/), rgb = colorAtom(value?.getAttribute('color'), cellRef), kind = value?.getAttribute('type');
          if (!value || !match || rgb.state !== 'measured' || !kind || !['NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DOUBLE_SLIM'].includes(kind)) return missing(cellRef, border ? 'unsupported' : 'unresolved_reference');
          return atom({ kind, widthPt: Number(match[1]) * 72 / 25.4, colorRgb: rgb.value }, raw!, 'mm', `header/borderFill/${borderRef}`);
        };
        const cell = { ref, row, column, rowSpan: Number(span.getAttribute('rowSpan')), columnSpan: Number(span.getAttribute('colSpan')), borders: sideRecord(borderAtom), fillRgb: colorAtom(first(border, 'winBrush', NS.core)?.getAttribute('faceColor'), `header/borderFill/${borderRef}`), paddingPt: sideRecord(side => numberAtom(margin?.getAttribute(side), ref!, 100)), paragraphRefs: [] };
        currentTable.cells.push(cell);
        const cells = tableCells.get(currentTable)!;
        // Match Array.find's first occurrence even for duplicate malformed addresses.
        if (!cells.has(ref)) cells.set(ref, cell);
      } else if (is(element, 'header', NS.para) || is(element, 'footer', NS.para)) ref = refs.add(is(element, 'header', NS.para) ? 'header' : 'footer', parent);
      else if (ref && ['ole', 'shape', 'rect', 'line', 'ellipse', 'arc', 'polygon', 'curve', 'textart', 'container', 'video', 'chart', 'pic', 'drawText', 'equation', 'footNote', 'endNote', 'fieldBegin', 'trackChange', 'masterPage'].includes(element.localName ?? '')) unsupported(element.localName!, ref);
      for (const child of children(element)) await walk(child, ref, currentTable);
    };
    for (const element of children(root)) await walk(element, null);
    pageNumberControls[refs.section] = pageNumberUnknown ? { state: 'unknown', count: null } : pageNumberCount ? { state: 'present', count: pageNumberCount } : { state: 'absent', count: 0 };
  }
  return { snapshot, texts, automaticMarkers, pageNumberControls, scriptRuns };
}
