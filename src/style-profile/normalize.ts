import type { Atom, MissingReason, Origin, RawScalar } from './types';
export function missing<T>(evidenceRef: string, reason: MissingReason = 'absent'): Atom<T> { return { state: 'not_measured', reason, evidenceRef }; }
export function atom<T>(value: T, raw: RawScalar, rawUnit: string, evidenceRef: string, origin: Origin = 'explicit'): Atom<T> { return { state: 'measured', value, raw, rawUnit, evidenceRef, origin }; }
export function numberAtom(raw: string | null | undefined, ref: string, divisor = 1, unit = 'HWPUNIT'): Atom<number> { if (raw == null || raw === '') return missing(ref); const value = Number(raw); return Number.isFinite(value) ? atom(value / divisor, value, unit, ref) : missing(ref, 'unsupported'); }
export function colorAtom(raw: string | null | undefined, ref: string): Atom<string> { return raw && /^#[a-f0-9]{6}$/i.test(raw) ? atom(raw.toUpperCase(), raw, 'RGB', ref) : missing(ref, raw ? 'unsupported' : 'absent'); }
export const languages = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'] as const;
export const sides = ['left', 'right', 'top', 'bottom'] as const;
export function languageRecord<T>(value: (language: typeof languages[number]) => T): Record<typeof languages[number], T> { return Object.fromEntries(languages.map(language => [language, value(language)])) as Record<typeof languages[number], T>; }
export function sideRecord<T>(value: (side: typeof sides[number]) => T): Record<typeof sides[number], T> { return Object.fromEntries(sides.map(side => [side, value(side)])) as Record<typeof sides[number], T>; }
