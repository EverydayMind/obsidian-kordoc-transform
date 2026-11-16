import { getLocale, type Locale } from './locale';
import messages from './engine-messages.json';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Only these placeholders contain engine-authored diagnostics. Other captures
// are document names/content, font names, paths, or numeric values and stay intact.
const nestedDiagnosticArguments: Record<number, readonly number[]> = {
  15:[1],28:[0],29:[0],44:[1],47:[0],53:[1],55:[0],56:[0],57:[0],59:[0],61:[1],65:[0],77:[0],78:[3],80:[0],81:[0],104:[2],196:[0],224:[0],225:[0],231:[0],236:[0],237:[0],238:[0],243:[0],304:[0],306:[0],316:[0],
  322:[0],326:[2],341:[2,3],342:[1],344:[1],349:[2,3],382:[1],424:[0],430:[1],431:[1],451:[0],452:[0],458:[0,1],474:[1],475:[1],478:[0],480:[0],494:[1],496:[0],507:[0],
};
const patterns = messages.map((pair,index)=>({...pair,index})).sort((a,b) => {
  const aCount = (a.ko.match(/\{\d+\}/g) ?? []).length;
  const bCount = (b.ko.match(/\{\d+\}/g) ?? []).length;
  return aCount - bCount || b.ko.length - a.ko.length;
}).map(pair => {
  const positions: number[] = [];
  let at = 0, pattern = '^';
  for (const match of pair.ko.matchAll(/\{(\d+)\}/g)) {
    pattern += escape(pair.ko.slice(at, match.index)) + '([\\s\\S]*?)';
    positions.push(Number(match[1])); at = (match.index ?? 0) + match[0].length;
  }
  return { ...pair, positions, pattern: new RegExp(pattern + escape(pair.ko.slice(at)) + '$') };
});

/** Match whole authored diagnostics; captured document text is preserved verbatim. */
export function engineMessage(text: string, locale: Locale = getLocale(), depth = 0): string {
  if (locale === 'ko' || depth > 8) return text;
  for (const entry of patterns) {
    const match = entry.pattern.exec(text);
    if (!match) continue;
    return entry.en.replace(/\{(\d+)\}/g, (_, index: string) => {
      const capture = match[entry.positions.indexOf(Number(index)) + 1] ?? '';
      // A nested diagnostic is localized only when it matches an entire known message.
      return nestedDiagnosticArguments[entry.index]?.includes(Number(index)) ? engineMessage(capture, locale, depth + 1) : capture;
    });
  }
  return text;
}

const documentFields = new Set(['blocks','markdown','text','metadata','outline','pages','table','match','label','value','before','after','data','buffer','sample']);
const diagnosticFields = new Set(['error','message','reason','suggest']);
export function localizeEngineResult<T>(value: T, locale: Locale = getLocale()): T {
  if (locale === 'ko') return value;
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown, diagnostic = false): unknown => {
    if (typeof item === 'string') return diagnostic ? engineMessage(item, locale) : item;
    if (!item || typeof item !== 'object' || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const result: unknown[] = []; seen.set(item,result);
      for (const child of item) result.push(visit(child,diagnostic));
      return result;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      // Session methods retain their original receiver and mutable state.
      return new Proxy(item, { get(target,key) {
        const member: unknown = Reflect.get(target,key,target);
        if (typeof member === 'function') return (...args: unknown[]) => invoke(member as EngineFunction,target,args,locale);
        return key === 'warnings' ? visit(member,true) : diagnosticFields.has(String(key)) ? visit(member,true) : member;
      }});
    }
    const result: Record<string,unknown> = {}; seen.set(item,result);
    for (const [key,child] of Object.entries(item)) result[key] = documentFields.has(key) ? child : visit(child, diagnostic || diagnosticFields.has(key) || key === 'warnings');
    return result;
  };
  return visit(value) as T;
}
type EngineFunction = (...args: unknown[]) => unknown;
function invoke(fn: EngineFunction, receiver: unknown, args: unknown[], locale: Locale): unknown {
  if (locale === 'ko') return Reflect.apply(fn,receiver,args);
  // HWPX generation also emits diagnostics by appending to options.warnings.
  // Only newly appended engine messages are translated; caller entries stay intact.
  const sinks = args.flatMap(arg => {
    const warnings: unknown = arg && typeof arg === 'object' ? Object.getOwnPropertyDescriptor(arg,'warnings')?.value : undefined;
    return Array.isArray(warnings) ? [{ warnings: warnings as unknown[], start: warnings.length }] : [];
  });
  const finishWarnings = () => {
    for (const sink of sinks) for (let i=sink.start;i<sink.warnings.length;i++) {
      const warning = sink.warnings[i];
      if (typeof warning === 'string') sink.warnings[i] = engineMessage(warning,locale);
    }
  };
  const complete = (value: unknown) => { finishWarnings(); return localizeEngineResult(value,locale); };
  const failed = (error: unknown): never => { finishWarnings(); throw localizedError(error,locale); };
  try {
    const result: unknown = Reflect.apply(fn,receiver,args);
    if (result instanceof Promise) return result.then(complete,failed);
    return complete(result);
  } catch(error) { return failed(error); }
}
function localizedError(error: unknown, locale: Locale): unknown {
  if (locale === 'ko' || !(error instanceof Error)) return error;
  const translated = engineMessage(error.message,locale);
  if (translated === error.message) return error;
  const copy = Object.create(Object.getPrototypeOf(error) as object | null) as Error;
  Object.defineProperties(copy,Object.getOwnPropertyDescriptors(error));
  copy.message = translated;
  return copy;
}
export function localizedEngine<T extends object>(engine: T): T {
  return new Proxy(engine, { get(target,key) {
    const member: unknown = Reflect.get(target,key,target);
    return typeof member === 'function' ? (...args: unknown[]) => invoke(member as EngineFunction,target,args,getLocale()) : member;
  }});
}
