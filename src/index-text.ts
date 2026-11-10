import { createHash } from "node:crypto";
import type { App, TAbstractFile, TFile } from "obsidian";

const isFile = (file: TAbstractFile | null): file is TFile => !!file && "extension" in file && "stat" in file;
import { VERSION } from "./engine";
import type { ParseWorkerPool } from "./batch-worker";
import { normalizeKordocProviderPath } from "./verbex-contract";
import { indexTextChunks } from "./index-text-blocks";
import { parseIndexSource } from "./index-text-parse";

export const INDEX_TEXT_EXTRACTOR = { id: "kordoc" as const, engineVersion: VERSION, chunkerVersion: 'chunks-section-1+plain+gfm+hf+pdf-page-1' };
export type IndexTextInput = { path: string; signal?: AbortSignal; maxChars?: number; ocr?: "off" | "candidates" };

/** Host-only disk projection. Never opens an editor or enables OCR/network. */
export function createIndexText(app: App, pool: () => ParseWorkerPool) {
  return async ({ path: input, signal, maxChars = 2000000, ocr = "off" }: IndexTextInput) => {
    const check = () => { if (signal?.aborted) throw new Error("Index extraction aborted"); };
    check();
    const path = normalizeKordocProviderPath(input);
    if (path.split("/").some((part) => part.startsWith("."))) return { status: "unsupported", message: "Hidden paths are not indexable" };
    const candidate = typeof app.vault.getFileByPath === "function" ? null : app.vault.getAbstractFileByPath(path);
    const file = typeof app.vault.getFileByPath === "function" ? app.vault.getFileByPath(path) : isFile(candidate) ? candidate : null;
    if (!file || !/^(hwp|hwpx|pdf)$/i.test(file.extension)) return { status: "unsupported", message: "HWP/HWPX/PDF file required" };
    const sourceStamp = { mtime: file.stat.mtime, size: file.stat.size };
    if (sourceStamp.size > 100 * 1024 * 1024) return { status: "too_large", message: "100MB limit" };
    const bytes = await app.vault.readBinary(file);
    check();
    if (bytes.byteLength > 100 * 1024 * 1024) return { status: "too_large", message: "100MB limit" };
    const sourceSha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    const result = await parseIndexSource(pool(), bytes, file.extension.toLowerCase() === 'pdf', { images: false, plain: true, tableFormat: "gfm", ocr: ocr === "candidates", formulaOcr: false, removeHeaderFooter: true }, signal);
    check();
    if (!result.success) {
      const status = ({ ENCRYPTED: "encrypted", DRM_PROTECTED: "drm", UNSUPPORTED_FORMAT: "unsupported", EMPTY_INPUT: "empty", DECOMPRESSION_BOMB: "bomb", ZIP_BOMB: "bomb", IMAGE_BASED_PDF: "needs_ocr" } as Record<string, string>)[result.code ?? "PARSE_ERROR"] ?? "corrupted";
      return { status, message: result.error, ...(status === "needs_ocr" ? { pageCount: result.pageCount ?? 0, quality: { needsOcr: true, ocrCandidatePages: [] } } : {}) };
    }
    const quality = result.qualitySummary ? { needsOcr: result.qualitySummary.needsOcr, ocrCandidatePages: result.qualitySummary.ocrCandidatePages, lowTextPageCount: result.qualitySummary.lowTextPageCount } : undefined;
    if (result.fileType === "pdf" && quality?.needsOcr && (result.qualitySummary?.totalTextChars ?? result.markdown.trim().length) < 200 && ocr === "off") return { status: "needs_ocr", message: "Scanned PDF has no searchable text", pageCount: result.pageCount ?? 0, quality };
    const limit = Number.isFinite(maxChars) ? Math.max(1, Math.min(2000000, Math.floor(maxChars))) : 2000000;
    let remaining = limit;
    let truncated = false;
    const chunks = indexTextChunks(result.blocks, result.fileType === 'pdf').flatMap((chunk, index) => {
      if (!chunk.text.trim()) return [];
      if (remaining <= 0) { truncated = true; return []; }
      const text = chunk.text.slice(0, remaining);
      if (text.length < chunk.text.length) truncated = true;
      remaining -= text.length;
      return [{ id: String(index), type: chunk.type, breadcrumb: [...chunk.breadcrumb], text, blockRange: chunk.blockRange,
        ...(chunk.page ? { page: chunk.page, pageEnd: Math.max(chunk.page, result.blocks[chunk.blockRange[1]]?.pageNumber ?? chunk.page) } : {}), ...(chunk.table ? { table: { rows: chunk.table.rows, cols: chunk.table.cols } } : {}) }];
    });
    if (!chunks.length) return { status: "empty", message: "No extractable text" };
    return { status: "ok", format: String(result.fileType), sourceSha256, sourceStamp, extractor: { ...INDEX_TEXT_EXTRACTOR, ocrApplied: ocr === "candidates" && !!result.warnings?.some((warning) => warning.code === "OCR_APPLIED") }, pageMode: result.metadata?.pageMode ?? (result.fileType === "pdf" ? "layout" : "section"), ...(quality ? { quality } : {}), pageCount: result.pageCount ?? null, outline: (result.outline ?? []).map(({ level, text }) => ({ level, text })), chunks, truncated, warnings: [...(result.warnings ?? []).reduce((counts, warning) => counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1), new Map<string, number>())].map(([code, count]) => ({ code, count })).concat(result.indexBatched ? [{ code: "INDEX_PDF_PAGE_BATCHED", count: 1 }] : []) };
  };
}
