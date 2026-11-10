import { Guard, LIMITS, StyleError } from './limits';
export type Record = { tag: number; level: number; index: number; data: Buffer };
export async function records(bytes: Buffer, guard: Guard): Promise<Record[]> {
  const result: Record[] = []; let offset = 0;
  while (offset < bytes.length) {
    await guard.tick();
    if (offset + 4 > bytes.length) throw new StyleError('corrupted', 'Truncated HWP record header.');
    const header = bytes.readUInt32LE(offset); offset += 4;
    let size = header >>> 20; const level = (header >>> 10) & 1023;
    if (size === 4095) { if (offset + 4 > bytes.length) throw new StyleError('corrupted', 'Truncated HWP extended header.'); size = bytes.readUInt32LE(offset); offset += 4; }
    if (offset + size > bytes.length || level > LIMITS.depth || result.length >= LIMITS.nodes) throw new StyleError('corrupted', 'HWP record boundary/count/depth.');
    result.push({ tag: header & 1023, level, index: result.length, data: bytes.subarray(offset, offset + size) }); offset += size;
  }
  return result;
}
