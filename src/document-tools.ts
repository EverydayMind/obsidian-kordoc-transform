import { artifactName } from "./artifact-formats";
import { L, getLocale, type Locale } from "./locale";
import {
  blocksToChunks, blocksToMarkdown, classifyTableTree, collectTableBlocks, compare,
  detectFormat, detectOle2Format, detectZipFormat, extractClickHereFields,
  extractFormSchema, extractTables, fillFormFields, fillHwpx, fillWithUniqueGuard,
  hwpxToProfile, lintGongmunText, lintMuncheText, markdownToHwpx, parse, patchHwp, patchHwpx,
  placeSealHwpx, redactMarkdown, renderDocument, renderDocumentToScene, renderHtml,
  validateHwpx, VERSION,
  type FillInput, type ParseOptions, type ParseSuccess, type RedactOptions, type MarkdownToHwpxOptions,
  type PageBBox,
} from "./engine";
import { redactDocument } from "./engine";
import { EMBEDDED_TEMPLATES } from "./template-data";
import { preprocessObsidianMarkdown, stripFrontmatter } from "./export-utils";
import { guardZipInput } from "./zip-input-guard";
import { requireRuntimePack } from "./runtime-paths";

export function createToolActions(locale: Locale = getLocale()) {
 const L = <T>(values: {ko:T;en:T}):T => values[locale];
 return {
  json: L({ ko: "구조화 데이터·문서 정보", en: "Structured data and document information" }), chunks: L({ ko: "RAG 청크", en: "RAG chunks" }), pages: L({ ko: "쪽별 본문", en: "Text by page" }), tables: L({ ko: "표 추출·분류", en: "Extract and classify tables" }),
  compare: L({ ko: "문서 신구 비교", en: "Compare document versions" }), form: L({ ko: "양식 필드·누름틀 분석", en: "Analyze form fields and click-here fields" }), fill: L({ ko: "양식 채우기", en: "Fill form" }),
  template: L({ ko: "표준 기안문 작성", en: "Create a standard draft" }), seal: L({ ko: "도장·서명 배치", en: "Place seal or signature" }), redact: L({ ko: "개인정보 마스킹", en: "Redact personal information" }),
  profile: L({ ko: "표 서식 프로필 추출", en: "Extract table format profile" }), patch: L({ ko: "수정한 Markdown을 원본에 반영", en: "Apply edited Markdown to source" }),
  editMarkdown: L({ ko: "서식 보존 편집용 Markdown 추출", en: "Extract Markdown for format-preserving editing" }), validate: L({ ko: "HWPX 구조 검사", en: "Validate HWPX structure" }),
  lint: L({ ko: "공문서 표기·문체 검사", en: "Check official document notation and style" }), preview: L({ ko: "HWP·HWPX 미리보기", en: "HWP/HWPX preview" }),
  svg: L({ ko: "쪽별 SVG 저장", en: "Save SVG by page" }), html: L({ ko: "레이아웃 HTML 저장", en: "Save layout HTML" }), printHtml: L({ ko: "인쇄용 HTML 저장", en: "Save print HTML" }),
  regions: L({ ko: "영역 정보·SVG 추출", en: "Extract region information and SVG" }),
  generate: L({ ko: "Markdown으로 HWPX 작성", en: "Create HWPX from Markdown" }),
} as const;
}
export type ToolAction = keyof ReturnType<typeof createToolActions>;
export interface ToolArtifact { suffix: string; extension: string; data: string | ArrayBuffer; }
export interface ToolRequest {
  action: ToolAction; name: string; buffer?: ArrayBuffer; markdown?: string;
  second?: ArrayBuffer; values?: Record<string, FillInput>; template?: string;
  image?: Uint8Array; imageExt?: "png" | "jpg" | "jpeg" | "gif" | "bmp";
  anchor?: string; sealOptions?: { occurrence?: number; sizeMm?: number; mode?: "auto" | "right" | "overlap"; dxMm?: number; dyMm?: number };
  options?: ParseOptions; tableIndex?: number; redactOptions?: RedactOptions;
  highlights?: string[]; reflowMode?: "keep" | "charAll"; requireUnique?: boolean;
  generateOptions?: MarkdownToHwpxOptions;
}
export interface ToolResult { artifacts: ToolArtifact[]; report: unknown; }

export const PARSE_BOOLEAN_OPTIONS = ["plain", "htmlTables", "keepTrailingEmptyCols", "classifyTables",
  "keepEmptyParagraphs", "includeFieldPlaceholders", "dedupeRunningHeaders", "inlineImages",
  "images", "tables", "removeHeaderFooter", "scriptTags"] as const;

/** Only offline parse settings can enter the engine; passwords stay in memory. */
export function offlineParseOptions(input: unknown = {}): ParseOptions {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const options: ParseOptions = { ocr: false, formulaOcr: false };
  if (typeof raw.ocr === "boolean" || raw.ocr === "force") options.ocr = raw.ocr;
  if (typeof raw.formulaOcr === "boolean") options.formulaOcr = raw.formulaOcr;
  for (const key of PARSE_BOOLEAN_OPTIONS) if (typeof raw[key] === "boolean") options[key] = raw[key];
  if (typeof raw.pages === "string" && raw.pages.trim()) {
    if (!/^\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*$/.test(raw.pages.trim())) throw new Error(L({ ko: "쪽 범위는 1-3 또는 1,3,5-7 형식으로 입력하세요.", en: "Enter a page range such as 1-3 or 1,3,5-7." }));
    options.pages = raw.pages.trim();
  }
  if (Array.isArray(raw.pages) && raw.pages.every((n) => Number.isInteger(n) && n > 0)) options.pages = raw.pages;
  if (raw.layoutTables === "visual" || raw.layoutTables === "keep") options.layoutTables = raw.layoutTables;
  if (typeof raw.password === "string" && raw.password) options.password = raw.password;
  return options;
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array || Buffer.isBuffer(item)) return { encoding: "base64", data: Buffer.from(item).toString("base64") };
    if (item && typeof item === "object" && "type" in item && item.type === "Buffer" && "data" in item && Array.isArray(item.data)) return { encoding: "base64", data: Buffer.from(item.data).toString("base64") };
    if (item instanceof ArrayBuffer) return { encoding: "base64", data: Buffer.from(item).toString("base64") };
    return item;
  }, 2);
}

export function parseValues(text: string): Record<string, FillInput> {
  const values: unknown = JSON.parse(text);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(L({ ko: "양식 값은 필드명과 값으로 이루어진 JSON 객체여야 합니다.", en: "Form values must be a JSON object of field names and values." }));
  const isValue = (v: unknown) => typeof v === "string" || Array.isArray(v) && v.every((x) => typeof x === "string");
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!key.trim() || !isValue(value) && !(value && typeof value === "object" && "value" in value && isValue(value.value) && (!("format" in value) || value.format === undefined || typeof value.format === "string"))) {
      throw new Error(L({ ko: `${key}: 문자열·문자열 배열·{value, format} 형태로 입력하세요.`, en: `${key}: Enter a string, array of strings, or {value, format}.` }));
    }
  }
  return values as Record<string, FillInput>;
}

export async function preciseDocumentFormat(buffer: ArrayBuffer): Promise<string> {
  buffer = buffer.slice(0);
  await guardZipInput(buffer);
  const type = detectFormat(buffer);
  return type === "hwpx" ? detectZipFormat(buffer) : type === "hwp" ? detectOle2Format(buffer) : type;
}

export async function parseOffline(buffer: ArrayBuffer, options: ParseOptions = {}): Promise<ParseSuccess> {
  if (options.ocr || options.formulaOcr) requireRuntimePack();
  buffer = buffer.slice(0);
  await guardZipInput(buffer);
  const result = await parse(buffer, offlineParseOptions(options));
  if (!result.success) throw new Error(`${result.error}${result.code ? ` (${result.code})` : ""}`);
  return result;
}

export function binaryArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function cropRegionSvg(svg: string, b: PageBBox): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => tag
    .replace(/\s(?:viewBox|width|height)="[^"]*"/g, "")
    .replace(/>$/, ` viewBox="${b.x} ${b.y} ${b.width} ${b.height}" width="${b.width}pt" height="${b.height}pt">`));
}

export async function runDocumentTool(request: ToolRequest): Promise<ToolResult> {
  request = { ...request, buffer: request.buffer?.slice(0), second: request.second?.slice(0) };
  if (request.buffer) await guardZipInput(request.buffer);
  if (request.second) await guardZipInput(request.second);
  const artifacts: ToolArtifact[] = [];
  const add = (suffix: string, extension: string, data: string | ArrayBuffer) => artifacts.push({ suffix, extension, data });
  const json = (suffix: string, value: unknown) => add(suffix, "json", jsonStringify(value));
  const options = offlineParseOptions(request.options);
  const bytes = () => { if (!request.buffer) throw new Error(L({ ko: "대상 문서를 선택하세요.", en: "Select a target document." })); return request.buffer; };
  const source = async () => request.markdown ?? (await parseOffline(bytes(), options)).markdown;
  let report: unknown;

  switch (request.action) {
    case "generate": {
      const warnings: string[] = [];
      add(artifactName("generated"), "hwpx", await markdownToHwpx(preprocessObsidianMarkdown(stripFrontmatter(await source())), { ...request.generateOptions, warnings }));
      report = { warnings }; break;
    }
    case "compare": {
      if (!request.second) throw new Error(L({ ko: "비교할 두 번째 문서를 선택하세요.", en: "Select the second document to compare." }));
      const diff = await compare(bytes(), request.second, options);
      report = diff;
      json(artifactName("comparison"), diff);
      add(artifactName("comparison"), "md", L({ ko: `# 문서 비교\n\n${jsonStringify(diff.stats)}\n\n`, en: `# Document comparison

${jsonStringify(diff.stats)}

` }) + diff.diffs.map((d) => `## ${d.type}\n\n${d.before?.text ?? ""}\n\n→ ${d.after?.text ?? ""}\n\n${d.cellDiffs ? jsonStringify(d.cellDiffs) : ""}`).join("\n\n"));
      break;
    }
    case "validate": report = await validateHwpx(bytes()); json(artifactName("validation"), report); break;
    case "lint": {
      const text = await source();
      report = { gongmun: lintGongmunText(text), munche: lintMuncheText(text) };
      json(artifactName("styleCheck"), report); break;
    }
    case "profile": report = await hwpxToProfile(bytes()); json(artifactName("formatProfile"), report); break;
    case "patch": {
      if (request.markdown === undefined) throw new Error(L({ ko: "반영할 Markdown을 선택하세요.", en: "Select Markdown to apply." }));
      const format = await preciseDocumentFormat(bytes());
      if (format !== "hwpx" && format !== "hwp") throw new Error(L({ ko: "원본 반영은 HWPX·HWP5만 지원합니다.", en: "Applying edits to the source supports HWPX and HWP5 only." }));
      const result = await (format === "hwpx" ? patchHwpx : patchHwp)(new Uint8Array(bytes()), request.markdown);
      if (!result.success || !result.data || result.skipped.length || result.verification && (result.verification.stats.added + result.verification.stats.removed + result.verification.stats.modified)) {
        throw new Error(L({ ko: `편집을 완전히 반영하지 못했습니다. 원본을 보존했습니다.\n${result.error ?? ""}\n${result.skipped.map((s) => s.reason).join("\n")}`, en: `Could not apply all edits. The source was preserved.
${result.error ?? ""}
${result.skipped.map((s) => s.reason).join("\n")}` }));
      }
      report = { applied: result.applied, verification: result.verification };
      add(artifactName("patched"), format, binaryArrayBuffer(result.data)); json(artifactName("patchReport"), report); break;
    }
    case "template":
    case "fill": {
      let buffer: ArrayBuffer;
      if (request.action === "template") {
        const template = EMBEDDED_TEMPLATES.find((t) => t.id === (request.template ?? "gian"));
        if (!template) throw new Error(L({ ko: "알 수 없는 내장 서식입니다.", en: "Unknown embedded template." }));
        buffer = binaryArrayBuffer(Buffer.from(template.base64, "base64"));
      } else buffer = bytes();
      if (!request.values) throw new Error(L({ ko: "채울 양식 값을 입력하세요.", en: "Enter values to fill the form." }));
      const format = await preciseDocumentFormat(buffer);
      if (format === "hwpx") {
        const result = request.requireUnique === false
          ? { ...await fillHwpx(buffer, request.values), rejected: [] as string[] }
          : await fillWithUniqueGuard(request.values, (values, blocked) => fillHwpx(buffer, values, blocked));
        const validation = await validateHwpx(result.buffer);
        if (!validation.ok) throw new Error(L({ ko: "작성 결과의 HWPX 구조 검사에 실패했습니다.", en: "HWPX structure validation failed for the generated document." }));
        add(artifactName("filled"), "hwpx", result.buffer);
        report = { filled: result.filled.map((f) => ({ label: f.label, key: f.key })), unmatched: result.unmatched, rejected: result.rejected, warnings: result.warnings };
      } else {
        const parsed = await parseOffline(buffer, { ...options, layoutTables: "keep", keepTrailingEmptyCols: true });
        const result = request.requireUnique === false
          ? { ...fillFormFields(parsed.blocks, request.values), rejected: [] as string[] }
          : await fillWithUniqueGuard(request.values, (values, blocked) => fillFormFields(parsed.blocks, values, blocked));
        add(artifactName("filled"), "md", blocksToMarkdown(result.blocks));
        report = { filled: result.filled.map((f) => f.label), unmatched: result.unmatched, rejected: result.rejected, warnings: result.warnings };
      }
      json(artifactName("fillReport"), report); break;
    }
    case "seal": {
      if (!request.image || !request.anchor?.trim()) throw new Error(L({ ko: "도장 이미지와 기준 문구를 입력하세요.", en: "Enter a seal image and anchor text." }));
      const result = await placeSealHwpx(bytes(), [{ ...request.sealOptions, image: request.image, ext: request.imageExt ?? "png", anchor: request.anchor }]);
      add(artifactName("sealed"), "hwpx", result.buffer); report = result.placed; json(artifactName("sealReport"), report); break;
    }
    case "redact": {
      const allowedRules = new Set(["rrn", "phone", "email", "card", "account", "brn", "crn", "passport", "driver", "ip", "name", "address"]);
      if (request.redactOptions?.rules && (!request.redactOptions.rules.length || request.redactOptions.rules.some((rule) => !allowedRules.has(rule)))) {
        throw new Error(L({ ko: "마스킹 검출 항목을 올바르게 지정하세요. 비우면 기본 항목을 사용합니다.", en: "Specify valid redaction detection rules. Leave empty for the defaults." }));
      }
      const format = request.markdown !== undefined ? "markdown" : await preciseDocumentFormat(bytes());
      if (format === "hwpx" || format === "hwp") {
        const result = await redactDocument(bytes(), request.redactOptions);
        if (result.residual.length || result.unscanned.length) throw new Error(L({ ko: `마스킹 후 검사에서 잔존 ${result.residual.length}건·검사 불가 ${result.unscanned.length}건이 발견되어 결과를 저장하지 않았습니다.`, en: `The result was not saved: post-redaction checks found ${result.residual.length} residual matches and ${result.unscanned.length} unscannable items.` }));
        report = { format, changed: result.changed, hits: result.fileHits, warnings: result.warnings, residual: result.residual, unscanned: result.unscanned };
        add(artifactName("redacted"), format, binaryArrayBuffer(result.data!));
      } else {
        const result = redactMarkdown(await source(), request.redactOptions);
        add(artifactName("redacted"), "md", result.text);
        report = { format, hits: result.hits, warnings: [L({ ko: "마스킹된 Markdown을 생성했습니다. 원본 파일과 이미지 속 글자는 수정하지 않습니다.", en: "Created redacted Markdown. The source file and text in images are not modified." })] };
      }
      json(artifactName("redactionReport"), report); break;
    }
    case "printHtml": add(artifactName("print"), "html", renderHtml(await source())); report = { format: "html" }; break;
    case "preview":
    case "svg":
    case "html":
    case "regions": {
      const renderOptions = { pages: options.pages, password: options.password, reflow: true, highlights: request.highlights, reflowMode: request.reflowMode };
      if (request.action === "regions") {
        const result = await renderDocumentToScene(bytes(), renderOptions);
        json(artifactName("region"), result.scene.regions);
        for (const region of result.scene.regions) {
          for (const b of region.regions) {
            const svg = result.pageSvgs.get(b.page);
            if (svg && b.width > 0 && b.height > 0) add(artifactName("regionPage", [region.id.replace(/[^\w-]/g, "_"), b.page]), "svg", cropRegionSvg(svg, b));
          }
        }
        report = result.scene.regions;
      } else {
        const result = await renderDocument(bytes(), { ...renderOptions, format: request.action === "html" ? "html" : "svg" });
        for (const asset of result.assets) add(asset.page ? artifactName("page", [asset.page]) : artifactName("layout"), asset.format, typeof asset.data === "string" ? asset.data : binaryArrayBuffer(asset.data));
        report = { format: result.scene.format, pageCount: result.scene.pages.length, warnings: result.scene.warnings };
        json(artifactName("renderReport"), report);
      }
      break;
    }
    default: {
      const parsed = await parseOffline(bytes(), { ...options,
        ...(request.action === "form" || request.action === "tables" || request.action === "editMarkdown" ? { layoutTables: "keep" as const, keepTrailingEmptyCols: true } : {}),
      });
      switch (request.action) {
        case "json": json(artifactName("structure"), parsed); report = { blocks: parsed.blocks.length, warnings: parsed.warnings, qualitySummary: parsed.qualitySummary }; break;
        case "chunks": report = blocksToChunks(parsed.blocks, { includeTableCells: true }); json(artifactName("chunks"), report); break;
        case "pages": {
          if (!parsed.pages?.length) throw new Error(L({ ko: "이 문서는 쪽별 본문을 제공하지 않습니다.", en: "This document does not provide page-by-page text." }));
          for (const page of parsed.pages) add(artifactName("page", [page.pageNumber]), "md", page.markdown);
          report = { pages: parsed.pages.length, pageMode: parsed.metadata?.pageMode }; break;
        }
        case "editMarkdown": add(artifactName("formatEdit"), "md", parsed.markdown); report = { layoutTables: "keep" }; break;
        case "form": {
          report = { ...extractFormSchema(parsed.blocks), clickHere: await preciseDocumentFormat(bytes()) === "hwpx" ? await extractClickHereFields(bytes()) : [] };
          json(artifactName("form"), report); break;
        }
        case "tables": {
          classifyTableTree(parsed.blocks);
          let tables: Array<{ table?: import("./engine").IRTable }> = collectTableBlocks(parsed.blocks).map((block, i) => ({ id: `tbl-${i + 1}`, table: block.table, page: block.pageNumber }));
          const format = await preciseDocumentFormat(bytes());
          // Engine extractTables reparses without caller options; use it only for whole, unencrypted documents.
          if ((format === "hwpx" || format === "hwp") && !options.password && !options.pages) tables = await extractTables(bytes(), { policy: "none" });
          if (request.tableIndex !== undefined) {
            if (!Number.isInteger(request.tableIndex) || request.tableIndex < 1 || request.tableIndex > tables.length) throw new Error(L({ ko: `표 순번은 1~${tables.length} 범위여야 합니다.`, en: `Table index must be in the range 1–${tables.length}.` }));
            tables = [tables[request.tableIndex - 1]];
          }
          json(artifactName("table"), tables);
          add(artifactName("table"), "md", blocksToMarkdown(tables.map((t) => ({ type: "table", table: t.table }))));
          report = { tables: tables.length }; break;
        }
      }
    }
  }
  return { artifacts, report: { engineVersion: VERSION, result: report } };
}
