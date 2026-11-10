import type { StyleSnapshot } from './types';
import { StyleError } from './limits';

export type RootAnchor = { blockIndex: number; section: number; paragraph: number };

export function validateRootAnchors(anchors: RootAnchor[]): void {
  if (!Array.isArray(anchors) || anchors.length > 5000) throw new StyleError('too_large', 'Anchor budget exceeded.');
  const indices = new Set<number>(), positions = new Set<number>();
  for (const anchor of anchors) {
    if (!anchor || !Number.isSafeInteger(anchor.blockIndex) || anchor.blockIndex < 0 || anchor.section !== 0 ||
        !Number.isSafeInteger(anchor.paragraph) || anchor.paragraph < 0 || indices.has(anchor.blockIndex) || positions.has(anchor.paragraph))
      throw new StyleError('corrupted', 'Invalid or duplicated output anchor.');
    indices.add(anchor.blockIndex); positions.add(anchor.paragraph);
  }
}

/** Internal coordinate translation after the caller has verified the file and section bytes. */
export function resolveRootAnchors(snapshot: StyleSnapshot, anchors: RootAnchor[]) {
  if (snapshot.source.format !== 'hwpx' || !snapshot.complete || snapshot.sections.length !== 1 || snapshot.sections[0].ref !== 's0')
    throw new StyleError('unsupported', 'Only a single measured HWPX section can be mapped.');
  validateRootAnchors(anchors);
  const roots = snapshot.nodes.filter(node => node.parentRef === null);
  if (roots.some((node, index) => node.kind !== 'paragraph' || node.topLevelOrder !== index || !/^s0\/p\d+$/.test(node.ref)) ||
      new Set(roots.map(node => node.ref)).size !== roots.length)
    throw new StyleError('unsupported', 'Ambiguous root paragraph structure.');
  return anchors.map(anchor => {
    const node = roots[anchor.paragraph];
    return node ? { blockIndex: anchor.blockIndex, state: 'matched' as const, ref: node.ref } :
      { blockIndex: anchor.blockIndex, state: 'unavailable' as const, reason: 'paragraph_missing' as const };
  });
}
