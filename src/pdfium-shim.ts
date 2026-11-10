// Electron has both window and Node: provide local WASM bytes explicitly so
// PDFium never guesses a browser URL or requests a CDN asset.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeRequire, runtimeResolve } from "./runtime-paths";
export const PDFiumLibrary = {
  async init(options: Record<string, unknown> = {}) {
    const real: unknown = runtimeRequire("@hyzyla/pdfium");
    if (!real || typeof real !== "object" || !("PDFiumLibrary" in real) || !real.PDFiumLibrary || (typeof real.PDFiumLibrary !== "object" && typeof real.PDFiumLibrary !== "function") || !("init" in real.PDFiumLibrary) || typeof real.PDFiumLibrary.init !== "function") throw new Error("PDFium runtime is unavailable.");
    const wasm = join(dirname(runtimeResolve("@hyzyla/pdfium")), "pdfium.wasm");
    return (real.PDFiumLibrary.init as (options: Record<string, unknown>) => unknown)({ ...options, wasmBinary: readFileSync(wasm) });
  },
};
