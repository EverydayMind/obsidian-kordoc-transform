import { Guard, LIMITS, StyleError } from './limits';

const END = 0xfffffffe, FREE = 0xffffffff;
/** Bounded CFB reader. Validates allocation chains before any stream decode.
 * Never falls back to a lenient chain traversal on damaged input. */
export async function readOle(input: Uint8Array, guard: Guard): Promise<Map<string, Buffer>> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const bad = (message: string): never => { throw new StyleError('corrupted', message); };
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return bad('Invalid OLE signature.');
  if (bytes.length > LIMITS.input) throw new StyleError('too_large', 'OLE input too large.');
  const version = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), miniShift = bytes.readUInt16LE(32);
  if (bytes.readUInt16LE(28) !== 0xfffe || !((version === 3 && shift === 9) || (version === 4 && shift === 12)) || miniShift !== 6 || bytes.readUInt32LE(56) !== 4096) throw new StyleError('unsupported', 'Unsupported CFB geometry.');
  const sectorSize = 2 ** shift, sectors = Math.floor(bytes.length / sectorSize) - 1;
  if (bytes.length % sectorSize) return bad('Partial OLE sector.');
  const sector = (id: number) => { if (!Number.isInteger(id) || id < 0 || id >= sectors) return bad('OLE sector out of bounds.'); return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize); };
  const fatIds: number[] = [];
  const addFat = (id: number) => { if (id !== FREE) { sector(id); if (fatIds.includes(id)) return bad('Duplicate FAT sector.'); fatIds.push(id); } };
  for (let index = 0; index < 109; index++) addFat(bytes.readUInt32LE(76 + index * 4));
  const difatIds = new Set<number>(); let difat = bytes.readUInt32LE(68);
  const difatCount = bytes.readUInt32LE(72), fatCount = bytes.readUInt32LE(44);
  if (difatCount > sectors || fatCount > sectors) return bad('OLE FAT count out of bounds.');
  for (let index = 0; index < difatCount; index++) { await guard.tick(); if (difatIds.has(difat)) return bad('OLE DIFAT cycle.'); difatIds.add(difat); const block = sector(difat); for (let offset = 0; offset < sectorSize - 4; offset += 4) addFat(block.readUInt32LE(offset)); difat = block.readUInt32LE(sectorSize - 4); }
  if ((difatCount && difat !== END) || fatIds.length !== fatCount) return bad('OLE FAT count/chain mismatch.');
  const fat = fatIds.flatMap(id => { const block = sector(id), values: number[] = []; for (let offset = 0; offset < sectorSize; offset += 4) values.push(block.readUInt32LE(offset)); return values; });
  const allocated = new Set<number>([...fatIds, ...difatIds]);
  const chain = async (start: number, size?: number): Promise<Buffer> => {
    const pieces: Buffer[] = [], seen = new Set<number>(); let current = start;
    while (current !== END) { await guard.tick(); if (seen.has(current) || allocated.has(current) || seen.size >= sectors) return bad('OLE sector cycle/overlap.'); const block = sector(current); seen.add(current); allocated.add(current); pieces.push(block); current = fat[current]; if (current === undefined || current === FREE) return bad('Broken OLE FAT chain.'); if (size !== undefined && pieces.length > Math.ceil(size / sectorSize)) return bad('OLE stream allocation exceeds size.'); }
    if (size !== undefined && pieces.length !== Math.ceil(size / sectorSize)) return bad('OLE stream length mismatch.');
    return Buffer.concat(pieces).subarray(0, size);
  };
  const directoryBytes = await chain(bytes.readUInt32LE(48));
  if (directoryBytes.length / 128 > LIMITS.entries) throw new StyleError('too_large', 'Too many OLE entries.');
  const entries: Array<{ name: string; type: number; left: number; right: number; child: number; start: number; size: number }> = [];
  for (let offset = 0; offset < directoryBytes.length; offset += 128) {
    await guard.tick(); const entry = directoryBytes.subarray(offset, offset + 128), type = entry[66], length = entry.readUInt16LE(64);
    if (type && (length < 2 || length > 64 || length % 2 || entry.readUInt16LE(length - 2) !== 0)) return bad('Invalid OLE directory name.');
    const name = type ? entry.subarray(0, length - 2).toString('utf16le') : '';
    const size = Number(entry.readBigUInt64LE(120));
    if (type && (name.includes('/') || name.includes('\\') || name === '..' || size > LIMITS.input || !Number.isSafeInteger(size))) return bad('Invalid OLE entry.');
    entries.push({ name, type, left: entry.readUInt32LE(68), right: entry.readUInt32LE(72), child: entry.readUInt32LE(76), start: entry.readUInt32LE(116), size });
  }
  const root = entries[0]; if (!root || root.type !== 5) return bad('Missing OLE root.');
  const miniCount = bytes.readUInt32LE(64);
  if (miniCount > sectors) return bad('Mini FAT count out of bounds.');
  const miniFatBytes = miniCount ? await chain(bytes.readUInt32LE(60), miniCount * sectorSize) : Buffer.alloc(0);
  const miniFat: number[] = []; for (let offset = 0; offset < miniFatBytes.length; offset += 4) miniFat.push(miniFatBytes.readUInt32LE(offset));
  const miniStream = root.size ? await chain(root.start, root.size) : Buffer.alloc(0), miniUsed = new Set<number>();
  const readMini = async (start: number, size: number) => {
    const chunks: Buffer[] = [], seen = new Set<number>(); let current = start;
    while (current !== END) { await guard.tick(); if (seen.has(current) || miniUsed.has(current) || current * 64 + 64 > miniStream.length || chunks.length >= Math.ceil(size / 64)) return bad('Invalid mini-stream chain.'); seen.add(current); miniUsed.add(current); chunks.push(miniStream.subarray(current * 64, current * 64 + 64)); current = miniFat[current]; if (current === undefined || current === FREE) return bad('Broken mini FAT.'); }
    if (chunks.length !== Math.ceil(size / 64)) return bad('Mini-stream length mismatch.');
    return Buffer.concat(chunks).subarray(0, size);
  };
  const result = new Map<string, Buffer>(), visited = new Set<number>([0]); let total = 0;
  const stack: Array<{ id: number; prefix: string; depth: number }> = root.child === FREE ? [] : [{ id: root.child, prefix: '', depth: 0 }];
  while (stack.length) {
    await guard.tick(); const { id, prefix, depth } = stack.pop()!;
    if (id === FREE) continue;
    if (visited.has(id) || !entries[id] || depth > LIMITS.depth) return bad('OLE directory cycle/depth.');
    visited.add(id); const entry = entries[id], path = prefix + entry.name;
    stack.push({ id: entry.left, prefix, depth }, { id: entry.right, prefix, depth });
    if (entry.type === 1) { if (entry.child !== FREE) stack.push({ id: entry.child, prefix: path + '/', depth: depth + 1 }); }
    else if (entry.type === 2) {
      if (result.has(path)) return bad('Duplicate OLE path.');
      total += entry.size; if (entry.size > LIMITS.stream || total > LIMITS.inflated) throw new StyleError('too_large', 'OLE stream byte limit.');
      const data = !entry.size ? Buffer.alloc(0) : entry.size < 4096 ? await readMini(entry.start, entry.size) : await chain(entry.start, entry.size);
      result.set(path, data);
    } else return bad('Invalid OLE directory type.');
  }
  return result;
}
