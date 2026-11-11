import { isAbsolute, join } from 'node:path';
import type * as Runtime from './style-profile/entry';
import { loadStyleProfileEntry } from './lazy-modules';

let directory = '';
let runtime: typeof Runtime | undefined;
let active = true;
export function configureStyleProfileDirectory(pluginDirectory: string): void {
  if (!isAbsolute(pluginDirectory)) throw new Error('Absolute plugin directory required.');
  const next = join(pluginDirectory, 'runtime');
  if (next !== directory) { runtime?.clearStyleTextCache(); runtime = undefined; }
  directory = next;
  active = true;
}
export function loadStyleProfile(): typeof Runtime {
  if (!active) throw new Error('Style runtime is unloaded.');
  return runtime ??= loadStyleProfileEntry();
}
export function clearLoadedStyleTextCache(): void { active = false; runtime?.clearStyleTextCache(); }
