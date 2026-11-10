import { createInflateRaw } from 'node:zlib';
import { ZipBudgetError } from './zip-budget';

/** Mirror the engine's local-header recovery scan, limiting actual section output
 * before the engine can allocate it. Invalid compressed sections remain skippable. */
export async function verifyRecoveryBudget(bytes: Uint8Array, limit = 256 * 1024 * 1024, signal?: AbortSignal): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0, entries = 0, totalText = 0, totalBytes = 0;
  while (pos < bytes.length - 30) {
    signal?.throwIfAborted();
    if (view.getUint32(pos, true) !== 0x04034b50) { pos++; continue; }
    if (++entries > 500) break;
    const method = view.getUint16(pos + 8, true), compressed = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true), extraLength = view.getUint16(pos + 28, true);
    if (nameLength > 1024) { pos += 30 + nameLength + extraLength; continue; }
    const start = pos + 30 + nameLength + extraLength;
    if (start + compressed > bytes.length) break;
    if (compressed === 0 && method !== 0) { pos = start; continue; }
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nameLength));
    const data = bytes.subarray(start, start + compressed);
    pos = start + compressed;
    const path = name.replace(/\\/g, '/');
    if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) continue;
    if (!name.toLowerCase().includes('section') || !name.endsWith('.xml')) continue;
    if (method !== 0 && method !== 8) continue;
    const decoder = new TextDecoder();
    const count = (chunk: Uint8Array) => {
      signal?.throwIfAborted();
      totalBytes += chunk.byteLength;
      if (totalBytes > limit) throw new ZipBudgetError('손상 ZIP의 압축 해제 크기가 너무 큽니다.');
      totalText += decoder.decode(chunk, { stream: true }).length * 2;
      if (totalText > limit) throw new ZipBudgetError('손상 ZIP의 압축 해제 크기가 너무 큽니다.');
    };
    if (method === 0) {
      for (let i = 0; i < data.length; i += 64 * 1024) count(data.subarray(i, i + 64 * 1024));
    }
    else {
      const inflater = createInflateRaw();
      const abort = () => inflater.destroy();
      signal?.addEventListener('abort', abort, { once: true });
      try { signal?.throwIfAborted(); inflater.end(data); for await (const chunk of inflater) count(chunk as Uint8Array); signal?.throwIfAborted(); }
      catch (error) { signal?.throwIfAborted(); if (error instanceof ZipBudgetError) throw error; continue; }
      finally { signal?.removeEventListener('abort', abort); inflater.destroy(); }
    }
    totalText += decoder.decode().length * 2;
    if (totalText > limit) throw new ZipBudgetError('손상 ZIP의 압축 해제 크기가 너무 큽니다.');
  }
  signal?.throwIfAborted();
}
