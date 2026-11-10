import { StyleError } from './limits';

/** Copy plain JSON without invoking accessors; enforce bounds before serialization. */
export function copyBoundedJson(input: unknown, maxBytes: number): unknown {
  const seen = new Set<object>();
  let nodes = 0, estimate = 0;
  const spend = (bytes: number) => {
    estimate += bytes;
    if (++nodes > 1500000 || estimate > maxBytes * 4) throw new StyleError('too_large', 'Semantic input exceeds its budget.');
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new StyleError('too_large', 'Semantic input is too deep.');
    if (value === null || typeof value === 'boolean') { spend(5); return value; }
    if (typeof value === 'string') { spend(Buffer.byteLength(value) + 2); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { spend(24); return value; }
    if (!value || typeof value !== 'object' || seen.has(value)) throw new StyleError('corrupted', 'Semantic input is not plain JSON.');
    seen.add(value); spend(2);
    const keys = Reflect.ownKeys(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1 || value.length > 1500000) throw new StyleError('corrupted', 'Invalid semantic input array.');
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) throw new StyleError('corrupted', 'Semantic input accessor or hole.');
        return copy(descriptor.value, depth + 1);
      });
    } else {
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new StyleError('corrupted', 'Semantic input is not a plain object.');
      const record: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') throw new StyleError('corrupted', 'Semantic input symbol key.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new StyleError('corrupted', 'Semantic input accessor or hidden field.');
        spend(Buffer.byteLength(key) + 3);
        Object.defineProperty(record, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      result = record;
    }
    seen.delete(value); return result;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new StyleError('too_large', 'Semantic input exceeds its byte limit.');
  return result;
}
