// Provisional bounded transport of snapshot/1; it is not snapshot/2.
import validate from './generated/snapshot.js'
import { copyBoundedJson } from './bounded-json.ts'
import { canonicalDigest, canonicalJson } from './digest.ts'
import { validateSnapshotReferences } from './validate.ts'

const FORMAT = 'kordoc-style-intern-experiment/0.2'
const PACKED_LIMIT = 4 * 1024 * 1024
const EXPANDED_LIMIT = 16 * 1024 * 1024
const MAX_STYLES = 4096
const MAX_CELLS = 50000
const MAX_LANGUAGE_ATOMS = 4096 * 7 * 3
const SIDES = ['left', 'right', 'top', 'bottom']
const LANGUAGES = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user']
const LANGUAGE_FIELDS = ['fonts', 'ratioPct', 'spacingPct']
const fail = (message) => { throw new Error(message) }
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, names) => record(value) && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key))
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

function validateExpanded(snapshot) {
  if (bytes(snapshot) > EXPANDED_LIMIT) fail('Expanded snapshot exceeds limit')
  if (!validate(snapshot)) fail('Invalid snapshot schema')
  validateSnapshotReferences(snapshot)
}

function styleMap(style, ref, encode) {
  if (!exact(style, ['borders', 'fillRgb', 'paddingPt']) || !exact(style.borders, SIDES) || !exact(style.paddingPt, SIDES)) fail('Invalid cell style')
  const atom = (value) => {
    if (!record(value) || !Object.hasOwn(value, 'evidenceRef')) fail('Invalid style atom')
    let evidence = value.evidenceRef
    if (encode) {
      if (typeof evidence !== 'string') fail('Invalid evidence ref')
      if (evidence === ref) evidence = { cell: true }
    } else if (record(evidence)) {
      if (!exact(evidence, ['cell']) || evidence.cell !== true) fail('Invalid self-reference marker')
      evidence = ref
    } else if (typeof evidence !== 'string') fail('Invalid evidence ref')
    return { ...value, evidenceRef: evidence }
  }
  return {
    borders: Object.fromEntries(SIDES.map((side) => [side, atom(style.borders[side])])),
    fillRgb: atom(style.fillRgb),
    paddingPt: Object.fromEntries(SIDES.map((side) => [side, atom(style.paddingPt[side])])),
  }
}

/** Encodes a validated text-free snapshot; it never changes production state. */
export function packSnapshotForExperiment(input) {
  const snapshot = copyBoundedJson(input, EXPANDED_LIMIT)
  validateExpanded(snapshot)
  const styles = [], byValue = new Map()
  const languageAtoms = [], byAtom = new Map()
  const characterStyles = snapshot.characterStyles.map((style) => {
    const result = { ...style }
    for (const field of LANGUAGE_FIELDS) {
      result[field] = Object.fromEntries(LANGUAGES.map((language) => {
        const atom = style[field][language], key = canonicalJson(atom)
        let index = byAtom.get(key)
        if (index === undefined) {
          if (languageAtoms.length >= MAX_LANGUAGE_ATOMS) fail('Too many language atoms')
          index = languageAtoms.length; languageAtoms.push(atom); byAtom.set(key, index)
        }
        return [language, index]
      }))
    }
    return result
  })
  const tables = snapshot.tables.map((table) => ({ ...table, cells: table.cells.map((cell) => {
    const { borders, fillRgb, paddingPt, ...rest } = cell
    const style = styleMap({ borders, fillRgb, paddingPt }, cell.ref, true)
    const key = canonicalJson(style)
    let index = byValue.get(key)
    if (index === undefined) {
      if (styles.length >= MAX_STYLES) fail('Too many cell styles')
      index = styles.length; styles.push(style); byValue.set(key, index)
    }
    return { ...rest, styleIndex: index }
  }) }))
  const packed = { format: FORMAT, measurementSha256: canonicalDigest(snapshot), snapshot: { ...snapshot, characterStyles, tables }, styles, languageAtoms }
  const packedBytes = bytes(packed)
  if (packedBytes > PACKED_LIMIT) {
    const error = new Error('Packed snapshot exceeds limit')
    error.packedBytes = packedBytes
    error.originalBytes = bytes(snapshot)
    error.componentBytes = Object.fromEntries(['sections', 'nodes', 'characterStyles', 'paragraphStyles', 'paragraphs', 'tables', 'unsupported', 'warnings'].map((name) => [name, bytes(packed.snapshot[name])]))
    error.componentBytes.cellStyles = bytes(packed.styles)
    error.componentBytes.languageAtoms = bytes(packed.languageAtoms)
    throw error
  }
  return packed
}

/** Bounded decoding requires the expected hash from an independent trusted source. */
export function unpackSnapshotForExperiment(input, expectedMeasurementSha256) {
  if (typeof expectedMeasurementSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedMeasurementSha256)) fail('Expected digest required')
  const packed = copyBoundedJson(input, PACKED_LIMIT)
  if (!exact(packed, ['format', 'measurementSha256', 'snapshot', 'styles', 'languageAtoms']) || packed.format !== FORMAT || packed.measurementSha256 !== expectedMeasurementSha256 || !record(packed.snapshot) || !Array.isArray(packed.snapshot.tables) || !Array.isArray(packed.snapshot.characterStyles) || packed.snapshot.characterStyles.length > 4096 || !Array.isArray(packed.styles) || packed.styles.length > MAX_STYLES || !Array.isArray(packed.languageAtoms) || packed.languageAtoms.length > MAX_LANGUAGE_ATOMS) fail('Invalid packed snapshot')
  const seen = new Set(), used = new Set(), styleBytes = []
  for (const style of packed.styles) {
    styleMap(style, '', false)
    const key = canonicalJson(style)
    if (seen.has(key)) fail('Duplicate cell style')
    seen.add(key); styleBytes.push(Buffer.byteLength(key, 'utf8'))
  }
  let estimate = bytes(packed), cells = 0
  const atomValues = new Set(), atomUsed = new Set(), atomBytes = []
  for (const atom of packed.languageAtoms) {
    if (!record(atom)) fail('Invalid language atom')
    const key = canonicalJson(atom)
    if (atomValues.has(key)) fail('Duplicate language atom')
    atomValues.add(key); atomBytes.push(Buffer.byteLength(key, 'utf8'))
  }
  for (const style of packed.snapshot.characterStyles) {
    if (!record(style)) fail('Invalid character style')
    for (const field of LANGUAGE_FIELDS) {
      if (!exact(style[field], LANGUAGES)) fail('Invalid language fields')
      for (const language of LANGUAGES) {
        const index = style[field][language]
        if (!Number.isSafeInteger(index) || index < 0 || index >= packed.languageAtoms.length) fail('Invalid language atom index')
        atomUsed.add(index); estimate += atomBytes[index] + 64
        if (estimate > EXPANDED_LIMIT) fail('Expanded snapshot exceeds limit')
      }
    }
  }
  if (atomUsed.size !== packed.languageAtoms.length) fail('Unused language atom')
  // Count before expanding; the estimate intentionally overcounts marker refs,
  // compact indices and dictionary bytes to keep expansion under the bound.
  for (const table of packed.snapshot.tables) {
    if (!record(table) || !Array.isArray(table.cells)) fail('Invalid table')
    for (const cell of table.cells) {
      if (!record(cell) || typeof cell.ref !== 'string' || !Number.isSafeInteger(cell.styleIndex) || cell.styleIndex < 0 || cell.styleIndex >= packed.styles.length || Object.hasOwn(cell, 'borders') || Object.hasOwn(cell, 'fillRgb') || Object.hasOwn(cell, 'paddingPt')) fail('Invalid cell style index')
      if (++cells > MAX_CELLS) fail('Too many cells')
      used.add(cell.styleIndex)
      estimate += styleBytes[cell.styleIndex] + 9 * Buffer.byteLength(JSON.stringify(cell.ref), 'utf8') + 128
      if (estimate > EXPANDED_LIMIT) fail('Expanded snapshot exceeds limit')
    }
  }
  if (used.size !== packed.styles.length) fail('Unused cell style')
  const characterStyles = packed.snapshot.characterStyles.map((style) => {
    const result = { ...style }
    for (const field of LANGUAGE_FIELDS) result[field] = Object.fromEntries(LANGUAGES.map((language) => [language, { ...packed.languageAtoms[style[field][language]] }]))
    return result
  })
  const snapshot = { ...packed.snapshot, characterStyles, tables: packed.snapshot.tables.map((table) => ({ ...table, cells: table.cells.map((cell) => {
    const { styleIndex, ...rest } = cell
    return { ...rest, ...styleMap(packed.styles[styleIndex], cell.ref, false) }
  }) })) }
  validateExpanded(snapshot)
  if (canonicalDigest(snapshot) !== expectedMeasurementSha256) fail('Measurement digest mismatch')
  return snapshot
}
