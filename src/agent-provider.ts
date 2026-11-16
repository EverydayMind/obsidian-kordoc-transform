import { L, getLocale, type Locale } from "./locale";
import type { App, TFile } from "obsidian";
import { parseOffline, preciseDocumentFormat, runDocumentTool, type ToolAction } from "./document-tools";
import { normalizeKordocProviderPath } from "./verbex-contract";

/**
 * Agent facade (agentinterop v1). An agent host discovers this object on the
 * plugin instance under AGENT_CAPABILITY_PROVIDER and calls describe()/callTool().
 * It knows nothing about any particular host. Every tool here only reads a
 * Vault document; nothing is written and no result file is created.
 * The older `api.provider` (HWPX block patch drafts) is a separate contract.
 */
export const AGENT_CAPABILITY_PROVIDER = Symbol.for("dev.agentinterop.capability-provider");
export const PROVIDERS_CHANGED_EVENT = "agentinterop:providers-changed";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}
export interface AgentCapabilityProvider {
  readonly protocol: "agentinterop";
  readonly protocolVersion: 1;
  describe(): Promise<JsonObject>;
  callTool(name: string, args: JsonObject, ctx?: { signal?: AbortSignal }): Promise<AgentToolResult>;
  dispose(): void;
}
export interface AgentProviderOptions {
  pluginId: string;
  name: string;
  version: string;
  /** Lower-case extensions without the dot. */
  extensions: readonly string[];
}

class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

/** Text per call. Kept under the declared maxResultChars so the host never cuts a page. */
const PAGE_CHARS = 8000;
const MAX_RESULT_CHARS = 12000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_LISTED = 40;

function tools(options: AgentProviderOptions, locale: Locale): JsonObject[] {
  const L = <T>(values: { ko: T; en: T }): T => values[locale];
const PATH = { type: "string", minLength: 1, maxLength: 4096, description: L({ ko: "Vault 기준 상대 경로.", en: "Vault-relative path." }) };
const PAGES = { type: "string", minLength: 1, maxLength: 64, description: L({ ko: "읽을 쪽 범위. 예: 1-3 또는 1,3,5-7. 생략하면 전체.", en: "Page range to read, e.g. 1-3 or 1,3,5-7. Omit to read all pages." }) };

  const types = options.extensions.map((extension) => `.${extension}`);
  const meta = (extra: JsonObject = {}): JsonObject => ({
    "dev.agentinterop/effect": "read", "dev.agentinterop/group": "core",
    "dev.agentinterop/resourceTypes": types, "dev.agentinterop/maxResultChars": MAX_RESULT_CHARS, ...extra,
  });
  // A host shows an extended tool only when the request mentions one of its keywords.
  const extended = (keywords: string[]): JsonObject => ({ "dev.agentinterop/group": "extended", "dev.agentinterop/keywords": keywords });
  const tool = (name: string, title: string, description: string, properties: JsonObject, required: string[], extra?: JsonObject): JsonObject => ({
    name, title, description,
    inputSchema: { type: "object", additionalProperties: false, required, properties },
    annotations: { readOnlyHint: true }, _meta: meta(extra),
  });
  return [
    tool("get_document_info", L({ ko: "문서 정보", en: "Document information" }),
      L({ ko: "HWP·HWPX·PDF·DOCX·XLSX·XLS·PPTX(Markdown 노트 제외) 문서의 실제 형식, 쪽 수, 문서 정보, 개요(제목 목록), 표 개수, 본문 길이를 돌려준다. 문서를 읽기 전에 크기와 구성을 알고 싶을 때 부른다.", en: "Return the actual format, page count, metadata, outline (headings), table count and body length of HWP, HWPX, PDF, DOCX, XLSX, XLS and PPTX documents (excluding Markdown notes). Call to learn a document's size and structure before reading it." }),
      { path: PATH }, ["path"]),
    tool("read_document", L({ ko: "문서 본문 읽기", en: "Read document text" }),
      L({ ko: "문서 본문을 Markdown으로 읽는다. 표는 Markdown 표로 나온다. 한 번에 약 8,000자씩 주며, 결과가 \"계속: cursor=...\"로 끝나면 그 cursor로 다시 불러 이어서 읽는다. 글자 인식(OCR)은 하지 않으므로 스캔한 PDF의 그림 속 글자는 나오지 않는다.", en: "Read document text as Markdown, including Markdown tables. Returns about 8,000 characters per call. If the result ends with \"Continue: cursor=...\", call again with that cursor to continue reading. Does not perform OCR, so text in scanned PDF images is not returned." }),
      { path: PATH, pages: PAGES, cursor: { type: "string", minLength: 1, maxLength: 200, description: L({ ko: "앞선 결과가 준 cursor. pages는 그때와 똑같이 준다. 처음에는 생략한다.", en: "The cursor from a previous result. Supply the same pages value as before. Omit on the first call." }) } }, ["path"]),
    tool("read_tables", L({ ko: "문서 표 읽기", en: "Read document tables" }),
      L({ ko: "문서의 표를 읽는다. table을 생략하면 표 목록(순번, 쪽, 행·열 수, 첫 행)을 주고, table에 순번을 주면 그 표 전체를 Markdown 표로 준다.", en: "Read document tables. Omit table to get a list (index, page, row/column counts and first row), or supply a table index to get that entire table as Markdown." }),
      { path: PATH, pages: PAGES, table: { type: "integer", minimum: 1, maximum: 100000, description: L({ ko: "표 순번(1부터). 목록을 볼 때와 같은 pages로 부른다.", en: "Table index (starting at 1). Use the same pages value as for the list." }) } }, ["path"]),
    tool("read_form_fields", L({ ko: "양식 필드 읽기", en: "Read form fields" }),
      L({ ko: "양식 문서에서 채울 수 있는 칸(라벨과 지금 값)과 HWPX 누름틀을 찾아 돌려준다.", en: "Find fillable fields (labels and current values) and HWPX click-here fields in a form document." }),
      { path: PATH }, ["path"], extended([L({ ko: "양식", en: "form" }), L({ ko: "서식", en: "template" }), L({ ko: "누름틀", en: "click-here" }), L({ ko: "필드", en: "field" }), L({ ko: "입력란", en: "input" }), L({ ko: "빈칸", en: "blank" }), L({ ko: "채우", en: "fill" }), "form"])),
    tool("compare_documents", L({ ko: "문서 신구 비교", en: "Compare document versions" }),
      L({ ko: "두 문서의 문단과 표 칸을 비교해 추가·삭제·수정된 곳을 돌려준다. path가 이전 문서, second_path가 새 문서다. 형식이 달라도 된다.", en: "Compare paragraphs and table cells in two documents and return additions, deletions and modifications. path is the old document; second_path is the new one. Formats may differ." }),
      { path: PATH, second_path: { ...PATH, description: L({ ko: "비교할 새 문서의 Vault 기준 상대 경로.", en: "Vault-relative path to the new document for comparison." }) } }, ["path", "second_path"], extended([L({ ko: "비교", en: "compare" }), L({ ko: "신구", en: "versions" }), L({ ko: "대비", en: "comparison" }), L({ ko: "차이", en: "difference" }), L({ ko: "달라", en: "different" }), L({ ko: "바뀐", en: "changed" }), L({ ko: "변경", en: "change" }), "compare", "diff"])),
    tool("lint_document", L({ ko: "공문서 표기·문체 검사", en: "Check official document notation and style" }),
      L({ ko: "문서의 공문서 표기(날짜·금액·항목 기호 등)와 개조식 문체를 검사하고, HWPX면 파일 구조도 검사한다. 고칠 곳의 목록만 주며 문서를 바꾸지 않는다. 고칠 때는 replace_in_file 같은 노트 도구가 아니라 그 형식의 문서 편집 도구를 쓴다.", en: "Check official document notation (dates, amounts, list symbols, etc.) and bullet-style writing; also validate file structure for HWPX. Returns a list of issues without modifying the document. Use editing tools for that document format to fix issues, rather than note tools such as replace_in_file." }),
      { path: PATH }, ["path"], extended([L({ ko: "검사", en: "check" }), L({ ko: "점검", en: "inspect" }), L({ ko: "검토", en: "review" }), L({ ko: "표기", en: "notation" }), L({ ko: "문체", en: "style" }), L({ ko: "맞춤법", en: "spelling" }), L({ ko: "오류", en: "error" }), "lint"])),
  ];
}

const instructions = (locale: Locale): string => L({ ko: "한글(HWP·HWPX)·PDF·Word·Excel·PowerPoint 문서를 읽는 도구다. Markdown 노트(.md)는 이 도구로 읽지 않는다. 노트는 read_file 같은 노트 읽기 도구를 쓴다. 문서 내용에 대해 답하기 전에 read_document나 read_tables로 실제 내용을 확인한다. 긴 문서는 get_document_info로 쪽 수와 개요를 먼저 보고 pages로 범위를 좁힌다. cursor는 그 결과가 나온 파일 상태에서만 유효하며 파일이 바뀌면 처음부터 다시 읽는다. 이 도구들은 문서를 바꾸지 않고 파일도 만들지 않는다. 이 문서들은 노트용 쓰기 도구로 고칠 수 없다. 고치려면 그 형식의 문서 편집 도구를 쓰고, 여기서 읽은 본문에는 그 도구의 핸들이나 블록 번호가 없으므로 그 도구의 읽기 도구로 대상을 다시 확인한다. 암호가 걸린 문서는 읽지 못한다.", en: "Tools for reading Hangul (HWP/HWPX), PDF, Word, Excel and PowerPoint documents. Do not use these tools for Markdown notes (.md); use note-reading tools such as read_file. Before answering questions about document content, verify the actual content with read_document or read_tables. For long documents, first check the page count and outline with get_document_info, then narrow the range with pages. A cursor is valid only for the file state that produced it; restart reading if the file changes. These tools do not modify documents or create files. Note-writing tools cannot edit these documents. Use editing tools for that document format; text read here has no handles or block numbers for those tools, so verify the targets again using their reading tools. Password-protected documents cannot be read." }, locale);

interface Loaded { file: TFile; path: string; buffer: ArrayBuffer; stamp: string }
interface Parsed { key: string; markdown: string; format: string; pageCount: number; sectionMode: boolean }
// HWPX without a layout cache reports sections, not rendered pages (metadata pageMode "section").
// Label them as sections so a model does not take "1쪽" as the real page count of a 5-page document.
const sectionMode = (metadata: unknown): boolean => (metadata as { pageMode?: unknown } | undefined)?.pageMode === "section";
const formatUnitCount = (count: number | string, sections: boolean, locale: Locale): string => {
 const L = <T>(values: {ko:T;en:T}):T => values[locale];
 return sections ? L({ ko: `구역 ${count}개(레이아웃 정보 없음, 실제 쪽 수 미확인)`, en: `${count} sections (no layout information; actual page count unknown)` }) : L({ ko: `${count}쪽`, en: `${count} pages` });
};

/** Runtime-safe TFile guard: Obsidian's TFile class is not available in headless tests. */
function isVaultFile(value: unknown): value is TFile {
  return Boolean(value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string" && typeof (value as { extension?: unknown }).extension === "string");
}

/** Plain JSON only: the host rejects undefined, class instances and binary values. */
function plain(value: unknown, depth = 0): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || depth > 12 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
  const record: JsonObject = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined && typeof item !== "function") record[key] = plain(item, depth + 1);
  return record;
}

const stringify: (value: unknown) => string = String;
const clip = (value: unknown, max: number): string => {
  const text = (typeof value === "string" ? value : stringify(value ?? "")).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

/** Joins lines up to the page budget and says how many were left out, so a cut is never silent. */
function boundedLines(lines: string[], omittedLabel: string, locale: Locale): string {
 const L = <T>(values: {ko:T;en:T}):T => values[locale];
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > PAGE_CHARS) break;
    kept.push(line); size += line.length + 1;
  }
  if (kept.length < lines.length) kept.push(L({ ko: `… ${omittedLabel} ${lines.length - kept.length}개는 길이 제한으로 생략했다.`, en: `… ${lines.length - kept.length} ${omittedLabel} omitted due to the length limit.` }));
  return kept.join("\n");
}

export function createAgentProvider(app: App, options: AgentProviderOptions, locale: Locale = getLocale()): AgentCapabilityProvider {
  const L = <T>(values: {ko:T;en:T}):T => values[locale];
  const unitCount = (count: number | string, sections: boolean) => formatUnitCount(count, sections, locale);
  const bounded = (lines: string[], label: string) => boundedLines(lines, label, locale);
  const descriptor: JsonObject = {
    provider: { id: options.pluginId, name: options.name, version: options.version, description: L({ ko: "한글·PDF·오피스 문서 읽기 (오프라인)", en: "Read Hangul, PDF and Office documents (offline)" }) },
    instructions: instructions(locale),
    tools: tools(options, locale),
  };
  const parsed = new Map<string, Parsed>();
  let disposed = false;

  const load = async (input: unknown, label = "path"): Promise<Loaded> => {
    let path: string;
    try { path = normalizeKordocProviderPath(input); }
    catch (error) { throw new ToolError("INVALID_ARGUMENT", `${label}: ${error instanceof Error ? error.message : String(error)}`, true); }
    const file = app.vault.getAbstractFileByPath(path);
    if (!isVaultFile(file)) {
      const name = path.split('/').pop();
      const matches = (app.vault.getFiles?.() ?? []).filter(candidate => {
        if (candidate.name !== name || candidate.path === path || candidate.path.split('/').some(part => part.startsWith('.'))) return false;
        try { normalizeKordocProviderPath(candidate.path); return true; } catch { return false; }
      }).map(candidate => candidate.path).sort((a, b) =>
        Number(b === name) - Number(a === name) || (a < b ? -1 : a > b ? 1 : 0)
      ).slice(0, 5);
      const candidates = JSON.stringify(matches);
      const hint = matches.length && candidates.length <= 6000
        ? L({ ko: `\n같은 파일명이 실제로 있는 Vault 상대 경로: ${candidates}\n이 경로를 확인해 새 요청으로 읽으세요. 폴더를 임의로 덧붙이지 마세요.`, en: `
Actual vault-relative paths with the same filename: ${candidates}
Verify these paths and read in a new request. Do not invent folder prefixes.` })
        : L({ ko: '\n이 경로의 부재만 확인했습니다. search_vault/list_files로 실제 경로를 확인하세요.', en: "\nOnly the absence of this path was confirmed. Use search_vault/list_files to find the actual path." });
      throw new ToolError("NOT_FOUND", L({ ko: `요청한 경로에 파일이 없다: ${path}${hint}`, en: `No file at the requested path: ${path}${hint}` }), true);
    }
    if (!options.extensions.includes(file.extension.toLowerCase())) {
      const hint = file.extension.toLowerCase() === 'md'
        ? L({ ko: '\nMarkdown(.md)는 호스트의 텍스트/노트 읽기 도구(예: read_file, read_note_section)를 사용하세요. 이 오류는 이 문서 읽기 도구의 입력 형식 제한이며, 파일 부재나 전체 읽기/내보내기 불가를 뜻하지 않습니다.', en: "\nFor Markdown (.md), use the host's text/note reading tools (e.g. read_file, read_note_section). This error indicates an input format restriction of this document reader; it does not mean the file is absent or cannot be read/exported by other tools." })
        : '';
      throw new ToolError("UNSUPPORTED_FORMAT", L({ ko: `이 문서 읽기 도구가 지원하지 않는 형식: .${file.extension}. 지원 형식: ${options.extensions.join(", ")}${hint}`, en: `Unsupported format for this document reader: .${file.extension}. Supported formats: ${options.extensions.join(", ")}${hint}` }));
    }
    const size = file.stat?.size ?? 0;
    if (size > MAX_FILE_BYTES) throw new ToolError("TOO_LARGE", L({ ko: `파일이 너무 크다(${Math.round(size / 1048576)}MB). 100MB 이하만 읽는다.`, en: `File too large (${Math.round(size / 1048576)}MB). Only files up to 100MB can be read.` }));
    return { file, path, buffer: await app.vault.readBinary(file), stamp: `${(file.stat?.mtime ?? 0).toString(36)}.${size.toString(36)}` };
  };
  const parse = async (source: Loaded, pages: unknown): Promise<Parsed> => {
    const range = typeof pages === "string" ? pages.trim() : "";
    const key = `${source.stamp}|${range}`;
    const cached = parsed.get(source.path);
    if (cached?.key === key) return cached;
    let result: Awaited<ReturnType<typeof parseOffline>>;
    try { result = await parseOffline(source.buffer, { ...(range ? { pages: range } : {}), images: false }); }
    catch (error) { throw new ToolError("PARSE_FAILED", L({ ko: `문서를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`, en: `Could not read the document: ${error instanceof Error ? error.message : String(error)}` })); }
    const entry: Parsed = { key, markdown: result.markdown ?? "", format: String(result.fileType ?? ""), pageCount: Number(result.pageCount) || 0, sectionMode: sectionMode(result.metadata) };
    parsed.delete(source.path); parsed.set(source.path, entry);
    // A few recent documents, so cursor paging does not reparse a large file on every call.
    if (parsed.size > 4) parsed.delete(parsed.keys().next().value as string);
    return entry;
  };
  const resource = (...sources: Loaded[]): JsonObject => ({
    "dev.agentinterop/resource": { path: sources[0].path },
    ...(sources.length > 1 ? { "dev.agentinterop/evidencePaths": sources.map((source) => source.path) } : {}),
  });
  const run = async (action: ToolAction, source: Loaded, extra: { pages?: unknown; second?: ArrayBuffer; tableIndex?: number } = {}): Promise<{ artifacts: Array<{ extension: string; data: string | ArrayBuffer }>; result: unknown }> => {
    const range = typeof extra.pages === "string" && extra.pages.trim() ? { pages: extra.pages.trim() } : {};
    try {
      const output = await runDocumentTool({ action, name: source.file.name, buffer: source.buffer, options: range, second: extra.second, tableIndex: extra.tableIndex });
      return { artifacts: output.artifacts, result: (output.report as { result?: unknown }).result };
    } catch (error) { throw new ToolError("TOOL_FAILED", error instanceof Error ? error.message : String(error)); }
  };

  const handlers: Record<string, (args: JsonObject) => Promise<AgentToolResult>> = {
    async get_document_info(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const format = await preciseDocumentFormat(source.buffer);
      let result: Awaited<ReturnType<typeof parseOffline>>;
      try { result = await parseOffline(source.buffer, { images: false }); }
      catch (error) { throw new ToolError("PARSE_FAILED", L({ ko: `문서를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`, en: `Could not read the document: ${error instanceof Error ? error.message : String(error)}` })); }
      const outline = (Array.isArray(result.outline) ? result.outline : []) as Array<{ level?: number; text?: string; pageNumber?: number }>;
      const tables = result.blocks.filter((block) => block.type === "table").length;
      const lines = [
        L({ ko: `문서 ${source.path} · 형식 ${format} · ${unitCount(result.pageCount ?? "?", sectionMode(result.metadata))} · 블록 ${result.blocks.length}개 · 표 ${tables}개 · 본문 ${result.markdown.length}자`, en: `Document ${source.path} · Format ${format} · ${unitCount(result.pageCount ?? "?", sectionMode(result.metadata))} · ${result.blocks.length} blocks · ${tables} tables · ${result.markdown.length} body characters` }),
        ...Object.entries(result.metadata ?? {}).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => `${key}: ${clip(value, 200)}`),
        ...(result.warnings?.length ? [L({ ko: `경고 ${result.warnings.length}건: ${result.warnings.slice(0, 5).map((warning) => clip((warning as { message?: unknown }).message ?? warning, 160)).join(" / ")}`, en: `${result.warnings.length} warnings: ${result.warnings.slice(0, 5).map((warning) => clip((warning as { message?: unknown }).message ?? warning, 160)).join(" / ")}` })] : []),
        ...(outline.length ? [L({ ko: "개요:", en: "Outline:" }), ...outline.slice(0, MAX_LISTED).map((item) => L({ ko: `${"  ".repeat(Math.max(0, (item.level ?? 1) - 1))}- ${clip(item.text, 120)}${item.pageNumber ? ` (${item.pageNumber}쪽)` : ""}`, en: `${"  ".repeat(Math.max(0, (item.level ?? 1) - 1))}- ${clip(item.text, 120)}${item.pageNumber ? L({ ko: ` (${item.pageNumber}쪽)`, en: ` (page ${item.pageNumber})` }) : ""}` }))] : []),
        ...(outline.length > MAX_LISTED ? [L({ ko: `… 개요 ${outline.length - MAX_LISTED}개 더 있음`, en: `… ${outline.length - MAX_LISTED} more outline items` })] : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { format, pageCount: result.pageCount ?? null, blocks: result.blocks.length, tables, characters: result.markdown.length, outlineItems: outline.length },
        _meta: resource(source),
      };
    },
    async read_document(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const range = typeof args.pages === "string" ? args.pages.trim() : "";
      const binding = `${source.stamp}|${range}`;
      let offset = 0;
      if (args.cursor !== undefined) {
        const [position, ...rest] = stringify(args.cursor).split(":");
        offset = Number.parseInt(position, 36);
        if (!Number.isSafeInteger(offset) || offset < 0 || rest.join(":") !== binding) throw new ToolError("CURSOR_STALE", L({ ko: "cursor가 이 파일 상태나 pages와 맞지 않는다. pages를 처음과 같게 주거나 cursor 없이 다시 읽어라.", en: "The cursor does not match this file state or pages. Supply the original pages value or read again without a cursor." }), true);
      }
      const document = await parse(source, range);
      const total = document.markdown.length;
      if (offset > total) throw new ToolError("CURSOR_STALE", L({ ko: "cursor가 문서 끝을 지났다. cursor 없이 다시 읽어라.", en: "The cursor is past the document end. Read again without a cursor." }), true);
      let end = Math.min(total, offset + PAGE_CHARS);
      if (end < total) {
        // Cut at a line end so a table row or a sentence is not split across pages.
        const breakAt = document.markdown.lastIndexOf("\n", end);
        if (breakAt > offset + PAGE_CHARS / 2) end = breakAt + 1;
      }
      const cursor = end < total ? `${end.toString(36)}:${binding}` : undefined;
      const text = [
        L({ ko: `문서 ${source.path} · 형식 ${document.format} · ${unitCount(document.pageCount, document.sectionMode)}${range ? ` · ${document.sectionMode ? "구역" : "쪽"} 범위 ${range}` : ""} · 본문 ${total}자 중 ${offset + (total ? 1 : 0)}~${end}`, en: `Document ${source.path} · Format ${document.format} · ${unitCount(document.pageCount, document.sectionMode)}${range ? L({ ko: ` · ${document.sectionMode ? "구역" : "쪽"} 범위 ${range}`, en: ` · ${document.sectionMode ? L({ ko: "구역", en: "Section" }) : L({ ko: "쪽", en: "Page" })} range ${range}` }) : ""} · Body characters ${offset + (total ? 1 : 0)}–${end} of ${total}` }),
        document.markdown.slice(offset, end),
        ...(cursor ? [L({ ko: `… 계속: cursor=${cursor} (남은 ${total - end}자)`, en: `… Continue: cursor=${cursor} (${total - end} characters remaining)` })] : []),
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { characters: total, from: offset, to: end, complete: !cursor, ...(cursor ? { cursor } : {}) },
        _meta: resource(source),
      };
    },
    async read_tables(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const index = typeof args.table === "number" ? args.table : undefined;
      const output = await run("tables", source, { pages: args.pages, tableIndex: index });
      const json = output.artifacts.find((artifact) => artifact.extension === "json");
      const tables = (json && typeof json.data === "string" ? JSON.parse(json.data) : []) as Array<{ table?: { rows?: number; cols?: number; cells?: Array<Array<{ text?: string }>> }; page?: number; pageNumber?: number }>;
      if (index !== undefined) {
        const markdown = stringify(output.artifacts.find((artifact) => artifact.extension === "md")?.data ?? "");
        const cut = markdown.length > PAGE_CHARS;
        return {
          content: [{ type: "text", text: L({ ko: `문서 ${source.path} · 표 ${index}\n${cut ? `${markdown.slice(0, PAGE_CHARS)}\n… 표가 길어 ${PAGE_CHARS}자에서 끊었다. 나머지는 read_document의 pages로 그 쪽을 읽어라.` : markdown}`, en: `Document ${source.path} · Table ${index}
${cut ? L({ ko: `${markdown.slice(0, PAGE_CHARS)}\n… 표가 길어 ${PAGE_CHARS}자에서 끊었다. 나머지는 read_document의 pages로 그 쪽을 읽어라.`, en: `${markdown.slice(0, PAGE_CHARS)}
… Table truncated at ${PAGE_CHARS} characters. Read that page using read_document with pages for the remainder.` }) : markdown}` }) }],
          structuredContent: { table: index, characters: markdown.length, complete: !cut },
          _meta: resource(source),
        };
      }
      const lines = tables.map((entry, position) => {
        const shape = entry.table ?? {};
        const page = entry.page ?? entry.pageNumber;
        const first = (shape.cells?.[0] ?? []).map((cell) => clip(cell?.text, 24)).join(" | ");
        return L({ ko: `표 ${position + 1}${page ? ` · ${page}쪽` : ""} · ${shape.rows ?? "?"}행 ${shape.cols ?? "?"}열 · 첫 행: ${clip(first, 160)}`, en: `Table ${position + 1}${page ? L({ ko: ` · ${page}쪽`, en: ` · Page ${page}` }) : ""} · ${shape.rows ?? "?"} rows, ${shape.cols ?? "?"} columns · First row: ${clip(first, 160)}` });
      });
      return {
        content: [{ type: "text", text: [L({ ko: `문서 ${source.path} · 표 ${tables.length}개${tables.length ? " · table에 순번을 주면 그 표 전체를 읽는다" : ""}`, en: `Document ${source.path} · ${tables.length} tables${tables.length ? L({ ko: " · table에 순번을 주면 그 표 전체를 읽는다", en: " · Supply a table index in table to read the entire table" }) : ""}` }), bounded(lines, L({ ko: "표", en: "tables" }))].filter(Boolean).join("\n") }],
        structuredContent: { tables: tables.length },
        _meta: resource(source),
      };
    },
    async read_form_fields(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const report = (await run("form", source)).result as { fields?: Array<{ label?: string; value?: string }>; clickHere?: Array<Record<string, unknown>>; confidence?: number } | undefined;
      const fields = report?.fields ?? [];
      const clickHere = report?.clickHere ?? [];
      const lines = [
        ...fields.map((field) => L({ ko: `칸 「${clip(field.label, 80)}」 = ${field.value ? `「${clip(field.value, 120)}」` : "(비어 있음)"}`, en: `Field 「${clip(field.label, 80)}」 = ${field.value ? `「${clip(field.value, 120)}」` : L({ ko: "(비어 있음)", en: "(empty)" })}` })),
        ...clickHere.map((field) => L({ ko: `누름틀 ${clip(JSON.stringify(plain(field)), 240)}`, en: `Click-here field ${clip(JSON.stringify(plain(field)), 240)}` })),
      ];
      return {
        content: [{ type: "text", text: [L({ ko: `문서 ${source.path} · 양식 칸 ${fields.length}개 · 누름틀 ${clickHere.length}개`, en: `Document ${source.path} · ${fields.length} form fields · ${clickHere.length} click-here fields` }), bounded(lines, L({ ko: "항목", en: "items" }))].filter(Boolean).join("\n") }],
        structuredContent: { fields: fields.length, clickHere: clickHere.length, ...(typeof report?.confidence === "number" ? { confidence: report.confidence } : {}) },
        _meta: resource(source),
      };
    },
    async compare_documents(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const second = await load(args.second_path, "second_path");
      const diff = (await run("compare", source, { second: second.buffer })).result as { stats?: Record<string, number>; diffs?: Array<{ type?: string; before?: { text?: string }; after?: { text?: string }; cellDiffs?: unknown }> } | undefined;
      const changes = (diff?.diffs ?? []).filter((item) => item.type !== "unchanged");
      const side = (value: unknown) => value ? `「${clip(value, 200)}」` : L({ ko: "(없음)", en: "(none)" });
      const lines = changes.flatMap((item) => {
        if (!Array.isArray(item.cellDiffs)) return [`[${item.type}] ${side(item.before?.text)} → ${side(item.after?.text)}`];
        // A changed table is reported cell by cell; rows and columns count from 1.
        const cells = (item.cellDiffs as Array<Array<{ type?: string; before?: string; after?: string }>>).flatMap((row, r) =>
          (Array.isArray(row) ? row : []).flatMap((cell, c) => cell && cell.type !== "unchanged" ? [L({ ko: `[표 칸 ${r + 1}행 ${c + 1}열 ${cell.type}] ${side(cell.before)} → ${side(cell.after)}`, en: `[Table cell row ${r + 1} column ${c + 1} ${cell.type}] ${side(cell.before)} → ${side(cell.after)}` })] : []));
        return cells.length ? cells : [L({ ko: `[${item.type}] 표`, en: `[${item.type}] Table` })];
      });
      return {
        content: [{ type: "text", text: [L({ ko: `비교 ${source.path} → ${second.path} · ${Object.entries(diff?.stats ?? {}).map(([key, value]) => `${key} ${value}`).join(" · ")}`, en: `Compare ${source.path} → ${second.path} · ${Object.entries(diff?.stats ?? {}).map(([key, value]) => `${key} ${value}`).join(" · ")}` }), bounded(lines, L({ ko: "변경", en: "changes" }))].filter(Boolean).join("\n") }],
        structuredContent: { stats: plain(diff?.stats ?? {}), changes: changes.length },
        _meta: resource(source, second),
      };
    },
    async lint_document(args): Promise<AgentToolResult> {
      const source = await load(args.path);
      const format = await preciseDocumentFormat(source.buffer);
      const lint = (await run("lint", source)).result as { gongmun?: unknown; munche?: unknown } | undefined;
      const issues = (value: unknown): Array<Record<string, unknown>> => {
        const entries: unknown = Array.isArray(value) ? value : value && typeof value === "object" && "issues" in value ? value.issues : [];
        return Array.isArray(entries) ? entries.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
      };
      const gongmun = issues(lint?.gongmun), munche = issues(lint?.munche);
      const structure = format === "hwpx" ? (await run("validate", source)).result as { ok?: boolean; issues?: Array<{ path?: string; message?: string }> } | undefined : undefined;
      const line = (kind: string, issue: Record<string, unknown>) => L({ ko: `[${kind}] ${clip(issue.message ?? issue.rule ?? JSON.stringify(plain(issue)), 200)}${issue.line ? ` (${stringify(issue.line)}행)` : ""}${issue.match ? ` 「${clip(issue.match, 80)}」` : ""}${issue.suggest ? ` → ${clip(issue.suggest, 120)}` : ""}`, en: `[${kind}] ${clip(issue.message ?? issue.rule ?? JSON.stringify(plain(issue)), 200)}${issue.line ? L({ ko: ` (${stringify(issue.line)}행)`, en: ` (line ${stringify(issue.line)})` }) : ""}${issue.match ? ` 「${clip(issue.match, 80)}」` : ""}${issue.suggest ? ` → ${clip(issue.suggest, 120)}` : ""}` });
      const lines = [
        ...(structure?.issues ?? []).map((issue) => L({ ko: `[구조] ${clip(issue.message, 200)}${issue.path ? ` (${issue.path})` : ""}`, en: `[Structure] ${clip(issue.message, 200)}${issue.path ? ` (${issue.path})` : ""}` })),
        ...gongmun.map((issue) => line(L({ ko: "표기", en: "Notation" }), issue)), ...munche.map((issue) => line(L({ ko: "문체", en: "Style" }), issue)),
      ];
      return {
        content: [{ type: "text", text: [L({ ko: `문서 ${source.path} · 형식 ${format}${structure ? ` · HWPX 구조 ${structure.ok ? "정상" : "문제 있음"}` : " · 구조 검사는 HWPX만 한다"} · 표기 ${gongmun.length}건 · 문체 ${munche.length}건`, en: `Document ${source.path} · Format ${format}${structure ? L({ ko: ` · HWPX 구조 ${structure.ok ? "정상" : "문제 있음"}`, en: ` · HWPX structure ${structure.ok ? L({ ko: "정상", en: "valid" }) : L({ ko: "문제 있음", en: "has issues" })}` }) : L({ ko: " · 구조 검사는 HWPX만 한다", en: " · Structure validation is available for HWPX only" })} · ${gongmun.length} notation issues · ${munche.length} style issues` }), bounded(lines, L({ ko: "항목", en: "items" }))].filter(Boolean).join("\n") }],
        structuredContent: { format, ...(structure ? { structureOk: structure.ok === true, structureIssues: structure.issues?.length ?? 0 } : {}), notation: gongmun.length, style: munche.length },
        _meta: resource(source),
      };
    },
  };

  return {
    protocol: "agentinterop",
    protocolVersion: 1,
    async describe() { return descriptor; },
    async callTool(name, args, ctx) {
      try {
        if (disposed) throw new ToolError("DISPOSED", L({ ko: "플러그인이 종료됐다.", en: "The plugin has shut down." }));
        const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
        if (!handler) throw new ToolError("UNKNOWN_TOOL", L({ ko: `알 수 없는 도구다: ${name}`, en: `Unknown tool: ${name}` }));
        const result = await handler(args ?? {});
        if (ctx?.signal?.aborted) throw new ToolError("CANCELLED", L({ ko: "호출이 취소됐다.", en: "The call was cancelled." }));
        return result;
      } catch (error) {
        const known = error instanceof ToolError;
        const code = known ? error.code : "INTERNAL", retryable = known && error.retryable;
        return {
          isError: true,
          content: [{ type: "text", text: known ? error.message : L({ ko: `도구 실행 중 오류: ${error instanceof Error ? error.message : String(error)}`, en: `Error running tool: ${error instanceof Error ? error.message : String(error)}` }) }],
          structuredContent: { code, retryable },
          _meta: { "dev.agentinterop/error": { code, retryable } },
        };
      }
    },
    dispose() { disposed = true; parsed.clear(); },
  };
}
