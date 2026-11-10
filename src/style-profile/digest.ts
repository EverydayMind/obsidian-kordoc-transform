import { createHash } from 'node:crypto';
export function byteDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (!input || typeof input !== 'object' || seen.has(input)) throw new Error('Not lossless plain JSON.');
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !('value' in descriptors[key]))) throw new Error('JSON accessor/symbol forbidden.');
    let result: string;
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || keys.length !== input.length + 1) throw new Error('Sparse/decorated JSON array.');
      const values: string[] = [];
      for (let index = 0; index < input.length; index++) { if (!descriptors[index]) throw new Error('Sparse JSON array.'); values.push(encode(descriptors[index].value)); }
      result = `[${values.join(',')}]`;
    } else {
      const proto: unknown = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null || keys.some(key => !descriptors[key as string].enumerable)) throw new Error('Not a plain JSON object.');
      result = `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(',')}}`;
    }
    seen.delete(input); return result;
  };
  return encode(value);
}
export function canonicalDigest(value: unknown): string { return byteDigest(Buffer.from(canonicalJson(value))); }
