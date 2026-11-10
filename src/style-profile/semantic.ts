import type { Atom, CharacterStyle, Paragraph, StyleSnapshot } from './types';
import { Guard, LIMITS, StyleError } from './limits';
import type { SemanticSpan } from './semantic-spans';
import { buildRelations, cellRelationScope, numberingRelation } from './buildRelations';
import { captureSemanticEvidence, semanticContainers, validateSemanticEvidence, type SemanticEvidence } from './semantic-evidence';
import type { AutomaticMarker } from './numbering';
import type { PageNumberControls } from './page-number-controls';
import type { ScriptRuns } from './script-runs';

export type SemanticRole = 'DOCUMENT_TITLE' | 'SECTION_HEADING' | 'SUBSECTION_HEADING' | 'ITEM_HEADING' | 'BODY_PARAGRAPH' | 'BULLET_ITEM' | 'CAPTION' | 'TABLE_HEADER' | 'TABLE_VALUE' | 'NOTE_PARAGRAPH' | 'FOOTNOTE' | 'SIGNATURE' | 'COVER' | 'EMPTY_SPACER';
export type DiscourseRole = 'BACKGROUND' | 'STATUS' | 'PROBLEM' | 'OBJECTIVE' | 'ACTION' | 'EFFECT' | 'SUMMARY';
type Prefix = 'NONE' | 'ROMAN' | 'ARABIC_DOT' | 'KOREAN_DOT' | 'ARABIC_PAREN' | 'KOREAN_PAREN' | 'BOTH_PAREN' | 'CIRCLED' | 'SYMBOL';
type Container = 'body' | 'cell' | 'header' | 'footer' | 'caption' | 'footnote';
export type SemanticFeatures = {
  container: Container; prefix: Prefix; prefixRank: number | null;
  ending: 'sentence' | 'noun_phrase' | 'other' | 'empty';
  wordCount: number; sizeRatio: number | null; bold: boolean | null;
  indentPt: number | null; hasDeeperFollowing: boolean; followingTable: boolean;
  discourse: Array<{ role: DiscourseRole; evidence: string }>;
  automaticMarker?: AutomaticMarker;
};
export type SemanticNode = {
  ref: string; features: SemanticFeatures;
  state: 'decided' | 'ambiguous' | 'unknown';
  candidates: Array<{ role: SemanticRole; rank: number; evidence: string[] }>;
  level: number | null; semanticParentRef: string | null;
  spans: SemanticSpan[]; spanCoverage: 'complete' | 'partial';
};
export type SemanticAnalysis = { schema: 'report-style-semantic-rules/0.2'; ruleSetVersion: 'ko-structure/0.4' | 'ko-structure/0.5' | 'ko-structure/0.6' | 'ko-structure/0.7' | 'ko-structure/0.8' | 'ko-structure/0.9' | 'ko-structure/0.10'; baselineSizePt: number | null; nodes: SemanticNode[] };

const measured = <T>(atom: Atom<T> | undefined): T | null => atom?.state === 'measured' ? atom.value : null;
const headings = new Set<SemanticRole>(['DOCUMENT_TITLE', 'SECTION_HEADING', 'SUBSECTION_HEADING', 'ITEM_HEADING']);
function dominant(paragraph: Paragraph, styles: CharacterStyle[]): CharacterStyle | undefined {
  const counts = new Map<number, number>();
  for (const run of paragraph.runs) counts.set(run.characterStyle, (counts.get(run.characterStyle) ?? 0) + run.length);
  const winner = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  return winner === undefined ? undefined : styles[winner];
}

export async function analyzeSemantic(snapshot: StyleSnapshot, texts: Map<string, string>, signal?: AbortSignal, automaticMarkers?: Map<string, AutomaticMarker>, pageNumberControls?: PageNumberControls, scriptRuns?: ScriptRuns): Promise<SemanticAnalysis> {
  const guard = new Guard(signal); guard.check();
  const workingLimit = LIMITS.snapshot * 2;
  return analyzeSemanticEvidence(snapshot, await captureSemanticEvidence(snapshot, texts, signal, guard, workingLimit, true, automaticMarkers, pageNumberControls, scriptRuns), signal, guard, workingLimit);
}

/** Re-run the same rule version from validated, text-free evidence. */
export async function analyzeSemanticEvidence(snapshot: StyleSnapshot, input: SemanticEvidence, signal?: AbortSignal, sharedGuard?: Guard, byteLimit = LIMITS.snapshot, snapshotLimit: number = LIMITS.snapshot): Promise<SemanticAnalysis> {
  const guard = sharedGuard ?? new Guard(signal); guard.check();
  const evidence = validateSemanticEvidence(snapshot, input, byteLimit, snapshotLimit);
  guard.check();
  const text = new Map(evidence.nodes.map(node => [node.ref, node]));
  const refs = new Map(snapshot.nodes.map(node => [node.ref, node]));
  const paragraphs = new Map(snapshot.paragraphs.map(p => [p.ref, p]));
  const containers = await semanticContainers(snapshot, guard);
  const sectionOf = (ref: string) => ref.split('/')[0];
  const sizes = snapshot.paragraphs.flatMap(p => {
    const style = snapshot.paragraphStyles[p.paragraphStyle];
    const size = measured(dominant(p, snapshot.characterStyles)?.sizePt);
    const item = text.get(p.ref)!;
    return containers.get(p.ref) === 'body' && !(measured(style?.outlineLevel) ?? 0) && size && item.rawNonempty ? [{ size, weight: item.textLength }] : [];
  }).sort((a, b) => a.size - b.size);
  const midpoint = sizes.reduce((sum, item) => sum + item.weight, 0) / 2;
  let cumulative = 0, baselineSizePt: number | null = null;
  for (const item of sizes) { cumulative += item.weight; if (cumulative >= midpoint) { baselineSizePt = item.size; break; } }
  const physical = snapshot.nodes;
  const scopeKey = (ref: string, parent: string | null) => `${sectionOf(ref)}\0${parent ?? ''}`;
  const nextSibling = new Map<string, number>();
  const nextMeaningful = new Map<string, number>();
  const following = new Map<string, { sibling: number | undefined; meaningful: number | undefined }>();
  for (let i = physical.length - 1; i >= 0; i--) {
    await guard.tick();
    const node = physical[i], scope = scopeKey(node.ref, node.parentRef);
    following.set(node.ref, { sibling: nextSibling.get(scope), meaningful: nextMeaningful.get(scope) });
    nextSibling.set(scope, i);
    const child = physical[i + 1];
    const wrapsTable = node.kind === 'paragraph' && !text.get(node.ref)?.rawNonempty && child?.kind === 'table' && child.parentRef === node.ref;
    if (node.kind === 'table' || wrapsTable || (node.kind === 'paragraph' && !!text.get(node.ref)?.rawNonempty)) nextMeaningful.set(scope, i);
  }
  const nonempty = snapshot.paragraphs.filter(p => text.get(p.ref)?.rawNonempty);
  const firstRef = nonempty.find(p => !['header', 'footer', 'footnote', 'caption'].includes(containers.get(p.ref)!))?.ref;
  const nonemptyPosition = new Map(nonempty.map((paragraph, index) => [paragraph.ref, index / Math.max(1, nonempty.length - 1)]));
  const nearDate = new Set<string>();
  let lastDateIndex = -100;
  let lastDateSection = '';
  for (const [index, paragraph] of nonempty.entries()) {
    if (text.get(paragraph.ref)?.dateRaw) { lastDateIndex = index; lastDateSection = sectionOf(paragraph.ref); }
    else if (sectionOf(paragraph.ref) === lastDateSection && index - lastDateIndex <= 6) nearDate.add(paragraph.ref);
  }
  const cells = new Map(snapshot.tables.flatMap(table => table.cells.map(cell => [cell.ref, { cell, table }] as const)));
  const nextCellParagraph = new Map<string, string>();
  for (const table of snapshot.tables) for (const cell of table.cells) {
    await guard.tick();
    for (let index = 0; index + 1 < cell.paragraphRefs.length; index++)
      nextCellParagraph.set(cell.paragraphRefs[index], cell.paragraphRefs[index + 1]);
  }
  const nodes: SemanticNode[] = [];
  let draftBytes = 0;
  const addNode = (node: SemanticNode) => {
    draftBytes += Buffer.byteLength(JSON.stringify(node)) + 1;
    if (draftBytes > LIMITS.snapshot) throw new StyleError('too_large', 'Semantic analysis exceeds 4 MiB.');
    nodes.push(node);
  };
  for (const p of snapshot.paragraphs) {
    await guard.tick();
    const item = text.get(p.ref)!;
    const prefix = { kind: item.prefix, rank: item.prefixRank, bullet: item.prefixBullet };
    const automatic = prefix.kind === 'NONE' && item.automaticMarker?.state === 'measured' ? item.automaticMarker : null;
    const ending = item.ending, words = item.wordCount;
    const char = dominant(p, snapshot.characterStyles);
    const size = measured(char?.sizePt), bold = measured(char?.bold);
    const para = snapshot.paragraphStyles[p.paragraphStyle];
    const indent = measured(para?.leftPt), outline = measured(para?.outlineLevel);
    const container = containers.get(p.ref)!;
    const nextIndex = following.get(p.ref)?.sibling;
    const next = nextIndex === undefined ? undefined : physical[nextIndex];
    const afterNext = nextIndex === undefined ? undefined : physical[nextIndex + 1];
    const followingTable = !!next && next.parentRef === refs.get(p.ref)?.parentRef &&
      (next.kind === 'table' || (next.kind === 'paragraph' && !text.get(next.ref)?.rawNonempty && afterNext?.kind === 'table' && afterNext.parentRef === next.ref));
    const meaningfulIndex = following.get(p.ref)?.meaningful;
    const candidate = meaningfulIndex === undefined ? undefined : physical[meaningfulIndex];
    const other = candidate?.kind === 'paragraph' ? paragraphs.get(candidate.ref) : undefined;
    const otherIndent = other && text.get(other.ref)?.rawNonempty ? measured(snapshot.paragraphStyles[other.paragraphStyle]?.leftPt) : null;
    const hasDeeperFollowing = indent !== null && otherIndent !== null && otherIndent > indent + 0.5;
    const ratio = size && baselineSizePt ? size / baselineSizePt : null;
    const discourse = item.discourse;
    const features: SemanticFeatures = { container, prefix: prefix.kind, prefixRank: prefix.rank, ending, wordCount: words, sizeRatio: ratio === null ? null : Math.round(ratio * 1000) / 1000, bold, indentPt: indent, hasDeeperFollowing, followingTable, discourse, ...(item.automaticMarker ? { automaticMarker: item.automaticMarker } : {}) };
    const spanResult = { spans: item.spans, spanCoverage: item.spanCoverage };
    const scores = new Map<SemanticRole, { rank: number; evidence: string[] }>();
    const add = (role: SemanticRole, rank: number, evidence: string) => { const old = scores.get(role) ?? { rank: 0, evidence: [] }; old.rank += rank; old.evidence.push(evidence); scores.set(role, old); };
    if (!item.contentNonempty) { addNode({ ref: p.ref, features, state: 'unknown', candidates: [], level: null, semanticParentRef: null, ...spanResult }); continue; }
    if (container === 'footnote') add('FOOTNOTE', 100, 'footnote_container');
    else if (container === 'caption' || item.caption) add('CAPTION', 90, 'caption_context');
    else if (item.note) add('NOTE_PARAGRAPH', 80, 'note_marker');
    else {
      if (container === 'cell') {
        const parent = refs.get(p.ref)?.parentRef; const cell = parent ? cells.get(parent) : undefined;
        const firstRow = cell?.cell.row === 0 && (cell.table.rowCount ?? 0) > 1;
        add('TABLE_VALUE', 30, 'cell_content');
        const nextRef = nextCellParagraph.get(p.ref);
        const nextParagraph = nextRef ? paragraphs.get(nextRef) : undefined;
        const nextBold = nextParagraph ? measured(dominant(nextParagraph, snapshot.characterStyles)?.bold) : null;
        if (bold && nextBold === false) add('TABLE_HEADER', 80, 'cell_label_before_value');
        else if (firstRow && bold) add('TABLE_HEADER', 55, 'first_row_bold');
        else add('TABLE_HEADER', 20, 'cell_header_possible');
        if (bold === false) add('TABLE_VALUE', 25, 'cell_unbold_value');
      } else add('BODY_PARAGRAPH', 30, 'body_default');
      let title = 0;
      if (outline && outline > 0) { title += 65; }
      if (ratio !== null && ratio >= 1.3) title += 30; else if (ratio !== null && ratio >= 1.15) title += 18;
      if (bold) title += 14;
      if (ending === 'noun_phrase') title += 20;
      if (words > 0 && words <= 4) title += 10;
      if (ending === 'sentence') title -= 22;
      if (indent !== null && indent <= 0) title += 5;
      if (prefix.kind !== 'NONE' && !prefix.bullet) title += 12;
      if (automatic?.kind === 'number') title += 12;
      if (followingTable) title += 25;
      if (hasDeeperFollowing) title += 8;
      if (container === 'cell' && prefix.kind === 'NONE') title -= 25;
      const titleRole: SemanticRole = automatic?.kind === 'number' ? automatic.level === 1 ? 'SECTION_HEADING' : automatic.level === 2 ? 'SUBSECTION_HEADING' : 'ITEM_HEADING' : prefix.kind === 'CIRCLED' ? 'ITEM_HEADING' : prefix.kind === 'KOREAN_DOT' ? 'SUBSECTION_HEADING' : prefix.kind === 'ARABIC_DOT' || prefix.kind === 'ROMAN' || prefix.kind === 'SYMBOL' && !prefix.bullet ? 'SECTION_HEADING' : prefix.kind === 'NONE' && p.ref === firstRef && measured(para?.align) === 'center' ? 'DOCUMENT_TITLE' : 'ITEM_HEADING';
      if (title > 0) add(titleRole, title, 'heading_combined_text_style_context');
      if (prefix.kind !== 'NONE') {
        let list = prefix.bullet ? 50 : prefix.kind === 'KOREAN_DOT' ? 35 : 20;
        if (ending === 'sentence') list += 30;
        if (container === 'cell' && ending === 'sentence') list += 20;
        else if (ending === 'other') list += 15;
        if (hasDeeperFollowing) list += 6;
        if (followingTable) list -= 15;
        add('BULLET_ITEM', list, 'numbered_content');
      }
      if (automatic) {
        let list = automatic.kind === 'bullet' ? 50 : 20;
        if (ending === 'sentence') list += 30;
        if (container === 'cell' && ending === 'sentence') list += 20;
        else if (ending === 'other') list += 15;
        if (hasDeeperFollowing) list += 6;
        if (followingTable) list -= 15;
        add('BULLET_ITEM', list, 'automatic_marker');
      }
      if (container === 'cell' && p.ref === firstRef && ratio !== null && ratio >= 1.3 && measured(para?.align) === 'center') add('DOCUMENT_TITLE', 80, 'prominent_cell_text');
      if (item.titleTerm && measured(para?.align) === 'center') add('DOCUMENT_TITLE', 75, 'document_title_terms');
      if ((nonemptyPosition.get(p.ref) ?? 1) < 0.2 && item.notice) add('COVER', 70, 'document_notice_identifier');
      const signaturePosition = (nonemptyPosition.get(p.ref) ?? 0) >= 0.65 && measured(para?.align) === 'center' && nearDate.has(p.ref);
      if (item.organization && words <= 4) add('SIGNATURE', signaturePosition ? 100 : container === 'cell' ? 25 : 40, 'organization_suffix');
      if (item.dateContent) add('SIGNATURE', 85, 'date_line');
    }
    const candidates = [...scores].map(([role, value]) => ({ role, ...value })).sort((a, b) => b.rank - a.rank || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
    const state = !candidates.length ? 'unknown' : candidates.length > 1 && candidates[0].rank - candidates[1].rank < 15 ? 'ambiguous' : 'decided';
    const top = state === 'decided' ? candidates[0].role : null;
    const level = top && headings.has(top) ? top === 'DOCUMENT_TITLE' ? 1 : top === 'SECTION_HEADING' ? 2 : top === 'SUBSECTION_HEADING' ? 3 : 4 : null;
    addNode({ ref: p.ref, features, state, candidates, level, semanticParentRef: null, ...spanResult });
  }
  const parents = await buildRelations(nodes.map(node => ({ ref: node.ref, role: node.state === 'decided' ? node.candidates[0]?.role ?? null : null, level: node.level, container: node.features.container, indentPt: node.features.indentPt, prefixRank: node.features.prefixRank, ...(['ko-structure/0.7', 'ko-structure/0.8', 'ko-structure/0.9', 'ko-structure/0.10'].includes(evidence.ruleSetVersion) ? { numbering: numberingRelation(node.features.prefix, node.features.automaticMarker) } : {}), ...(['ko-structure/0.8', 'ko-structure/0.9', 'ko-structure/0.10'].includes(evidence.ruleSetVersion) && node.features.container === 'cell' ? { cellScope: cellRelationScope(node.ref, refs) } : {}) })), () => guard.tick());
  nodes.forEach((node, index) => { node.semanticParentRef = parents[index]; });
  const result: SemanticAnalysis = { schema: 'report-style-semantic-rules/0.2', ruleSetVersion: evidence.ruleSetVersion, baselineSizePt, nodes };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.snapshot) throw new StyleError('too_large', 'Semantic analysis exceeds 4 MiB.');
  return result;
}
