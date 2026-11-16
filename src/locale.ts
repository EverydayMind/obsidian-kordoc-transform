export type Locale = 'ko' | 'en';
let initialized: Locale | undefined;
let override: Locale | undefined;

function validLanguage(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.trim());
}
export function resolveLocale(appLanguage: () => unknown, browserLanguage: () => unknown = () => typeof navigator === 'undefined' ? undefined : navigator.language): Locale {
  for (const read of [appLanguage, browserLanguage]) {
    try {
      const value = read();
      if (validLanguage(value)) return value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
    } catch { /* Try the fallback only when this source is unavailable. */ }
  }
  return 'en';
}
/** Called once in onload; the locale stays pinned for this plugin lifetime. */
export function initLocale(appLanguage: () => unknown): Locale {
  return initialized ??= resolveLocale(appLanguage);
}
export function getLocale(): Locale { return override ?? initialized ?? 'en'; }
export function setLocaleForTests(value: Locale | undefined): void { override = value; }
export function L<T>(values: { ko: T; en: T }, locale: Locale = getLocale()): T { return values[locale]; }
