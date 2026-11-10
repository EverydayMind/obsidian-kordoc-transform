import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import type * as Engine from "./engine-entry";
import { configureRuntimePaths } from "./runtime-paths";

let runtimeDirectory = "";
let engine: typeof Engine | undefined;

/** Obsidian evaluates main.js with Electron's __filename, so onload must
 * provide the installed plugin directory using the Vault adapter/manifest. */
export function configureEngineDirectory(pluginDirectory: string): void {
  configureRuntimePaths(pluginDirectory);
  if (!isAbsolute(pluginDirectory)) throw new Error("KorDoc 플러그인 설치 경로는 절대 경로여야 합니다.");
  const next = join(pluginDirectory, "runtime");
  if (next !== runtimeDirectory) engine = undefined;
  runtimeDirectory = next;
}

export function loadEngine(): typeof Engine {
  return engine ??= (typeof require === "function"
    ? require("./engine-entry")
    : createRequire(import.meta.url)("../runtime/engine.cjs")) as typeof Engine;
}

export function workerPath(): string {
  return join(runtimeDirectory, "parse-worker.cjs");
}
