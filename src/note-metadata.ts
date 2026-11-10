import type { MetadataCache, TFile } from "obsidian";

/** A created TFile may precede its Markdown cache. Wait before auto-opening it
 * so consumers of the active file can read frontmatter/headings safely. */
export function waitForNoteMetadata(cache: MetadataCache, file: TFile, timeoutMs = 5000): Promise<boolean> {
  if (cache.getFileCache(file)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      cache.offref(ref);
      resolve(ready);
    };
    const ref = cache.on("changed", changed => {
      if (changed.path === file.path && cache.getFileCache(file)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (cache.getFileCache(file)) finish(true);
  });
}
