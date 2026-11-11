export const STYLE_TEXT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/** One in-memory document, with an absolute lifetime and an explicit unload boundary. */
export class StyleTextCache<T> {
  private entry?: { key: string; value: T; expires: number };
  private timer?: number;
  private generation = 0;
  constructor(private readonly ttl = 60_000, private readonly maxBytes = STYLE_TEXT_CACHE_MAX_BYTES, private readonly now = Date.now) {}
  version(): number { return this.generation; }
  get(key: string): T | undefined {
    if (!this.entry) return undefined;
    if (this.now() >= this.entry.expires) { this.clear(); return undefined; }
    return this.entry.key === key ? this.entry.value : undefined;
  }
  put(key: string, value: T, bytes: number, version: number): void {
    if (version !== this.generation) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return;
    if (this.entry?.key === key) {
      // Partial refills can retain earlier text. Do not renew its lifetime.
      if (this.now() >= this.entry.expires) { this.clear(); return; }
      this.entry.value = value;
      this.generation++;
      return;
    }
    this.clear();
    const entry = { key, value, expires: this.now() + this.ttl };
    this.entry = entry;
    this.timer = window.setTimeout(() => { if (this.entry === entry) this.clear(); }, this.ttl);
    const handle: unknown = this.timer;
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") (handle.unref as () => void)();
  }
  clear(): void {
    this.generation++;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.entry = undefined;
  }
}
