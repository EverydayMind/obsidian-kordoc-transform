/** Shared deterministic relation algorithm. Inputs contain no source text. */
export type RelationNode = {
  ref: string
  role: string | null
  level: number | null
  container: string
  indentPt: number | null
  prefixRank: number | null
  numbering?: { series: string; level: number }
  cellScope?: string
  fixedParentRef?: string | null
}

/** Find the nearest physical cell; malformed and excessively deep graphs fail closed. */
export function cellRelationScope(
  ref: string,
  nodes: ReadonlyMap<string, { parentRef: string | null; kind: string }>,
): string | undefined {
  const visited = new Set<string>()
  let current: string | null = ref
  while (current && visited.size < 256 && !visited.has(current)) {
    visited.add(current)
    const node = nodes.get(current)
    if (!node) return
    if (node.kind === 'cell') return current
    current = node.parentRef
  }
}

const headings = new Set([
  'DOCUMENT_TITLE',
  'SECTION_HEADING',
  'SUBSECTION_HEADING',
  'ITEM_HEADING',
])

/** The generated series is comparable only when no visible marker overrides it. */
export function numberingRelation(
  prefix: unknown,
  marker: unknown,
): RelationNode['numbering'] {
  if (prefix !== 'NONE' || !marker || typeof marker !== 'object') return
  const value = marker as Record<string, unknown>
  if (
    value.state !== 'measured' ||
    !['number', 'bullet'].includes(String(value.kind)) ||
    typeof value.series !== 'string' ||
    !/^n[1-9][0-9]{0,5}$/.test(value.series) ||
    !Number.isInteger(value.level) ||
    (value.level as number) < 1 ||
    (value.level as number) > 9
  )
    return
  return { series: value.series, level: value.level as number }
}

export async function buildRelations(
  nodes: RelationNode[],
  checkpoint?: () => Promise<void>,
): Promise<(string | null)[]> {
  const stack: RelationNode[] = []
  const seen = new Set<string>()
  const parents: (string | null)[] = []
  for (const node of nodes) {
    if (checkpoint) await checkpoint()
    if (!node.ref || seen.has(node.ref))
      throw new Error('Duplicate relation ref.')
    const heading = node.role !== null && headings.has(node.role)
    if (
      (heading &&
        (node.level === null ||
          !Number.isInteger(node.level) ||
          node.level < 1 ||
          node.level > 9)) ||
      (!heading && node.level !== null) ||
      (node.indentPt !== null && !Number.isFinite(node.indentPt)) ||
      (node.prefixRank !== null &&
        (!Number.isInteger(node.prefixRank) || node.prefixRank < 1)) ||
      (node.numbering !== undefined &&
        (!/^n[1-9][0-9]{0,5}$/.test(node.numbering.series) ||
          !Number.isInteger(node.numbering.level) ||
          node.numbering.level < 1 ||
          node.numbering.level > 9)) ||
      (node.cellScope !== undefined &&
        (node.container !== 'cell' ||
          node.cellScope.length > 256 ||
          !/^s\d+(?:\/(?:p\d+|t\d+|c\d+\.\d+|h\d+|f\d+))*\/c\d+\.\d+$/.test(
            node.cellScope,
          ))) ||
      (Object.prototype.hasOwnProperty.call(node, 'fixedParentRef') &&
        node.fixedParentRef !== null &&
        (typeof node.fixedParentRef !== 'string' ||
          !seen.has(node.fixedParentRef)))
    )
      throw new Error('Invalid relation input.')
    seen.add(node.ref)
    if (node.container === 'header' || node.container === 'footer') {
      parents.push(null)
      continue
    }
    const previous = stack.at(-1)
    if (previous && previous.ref.split('/')[0] !== node.ref.split('/')[0])
      stack.length = 0
    if (heading) {
      while (
        stack.length &&
        (stack[stack.length - 1].level ?? 99) >= (node.level ?? 0)
      )
        stack.pop()
    } else {
      while (stack.length && stack[stack.length - 1].role === 'BULLET_ITEM') {
        const parent = stack[stack.length - 1]
        if (
          node.container === 'cell' &&
          parent.container === 'cell' &&
          node.cellScope &&
          parent.cellScope &&
          node.cellScope !== parent.cellScope
        ) {
          stack.pop()
          continue
        }
        const deeperIndent =
          node.indentPt !== null &&
          parent.indentPt !== null &&
          node.indentPt > parent.indentPt + 0.5
        const deeperPrefix =
          node.prefixRank !== null &&
          parent.prefixRank !== null &&
          node.prefixRank > parent.prefixRank
        const sameNumbering =
          ((node.container === 'body' && parent.container === 'body') ||
            (node.container === 'cell' &&
              parent.container === 'cell' &&
              node.cellScope !== undefined &&
              node.cellScope === parent.cellScope)) &&
          node.numbering !== undefined &&
          parent.numbering !== undefined &&
          node.numbering.series === parent.numbering.series
        if (
          sameNumbering
            ? (node.numbering?.level ?? 0) > (parent.numbering?.level ?? 0)
            : deeperIndent || deeperPrefix
        )
          break
        stack.pop()
      }
    }
    const computed = stack.at(-1)?.ref ?? null
    parents.push(
      Object.prototype.hasOwnProperty.call(node, 'fixedParentRef')
        ? (node.fixedParentRef ?? null)
        : computed,
    )
    if (heading || node.role === 'BULLET_ITEM') stack.push(node)
  }
  return parents
}
