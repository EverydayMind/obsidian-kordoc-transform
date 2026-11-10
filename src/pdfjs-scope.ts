/** PDF.js's webpack builds publish their API/worker on globalThis by default.
 * Keep the bundled 4.x pair together without replacing Obsidian's 5.x pair. */
export const pdfjsScope: { pdfjsLib?: unknown; pdfjsWorker?: unknown } = {};
