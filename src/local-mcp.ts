import { L, getLocale, type Locale } from "./locale";
import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./engine";

export function createLocalMcpTools(locale: Locale = getLocale()) {
 const L = <T>(values: {ko:T;en:T}):T => values[locale];
 const file = { type: "string", description: L({ ko: "볼트 기준 상대 파일 경로", en: "Vault-relative file path" }) };
const object = { type: "object", additionalProperties: true };
const shared = { path: file, pages: { type: "string" }, password: { type: "string" } };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
  ["parse_document", L({ ko: "문서를 Markdown과 구조 데이터로 읽기 (로컬 OCR 선택 가능)", en: "Read a document as Markdown and structured data (optional local OCR)" }), { ...shared, options: object }, ["path"]],
  ["detect_format", L({ ko: "실제 문서 형식 감지", en: "Detect actual document format" }), { path: file }, ["path"]],
  ["parse_metadata", L({ ko: "문서 정보 읽기", en: "Read document information" }), shared, ["path"]],
  ["parse_pages", L({ ko: "특정 쪽 본문 읽기", en: "Read text on specified pages" }), shared, ["path"]],
  ["parse_table", L({ ko: "표 추출", en: "Extract tables" }), { ...shared, table_index: { type: "integer", minimum: 1 } }, ["path"]],
  ["parse_chunks", L({ ko: "위계·표를 보존한 RAG 청크", en: "RAG chunks preserving hierarchy and tables" }), shared, ["path"]],
  ["compare_documents", L({ ko: "문단·표 셀 신구 비교", en: "Compare paragraphs and table cells between document versions" }), { ...shared, second_path: file }, ["path", "second_path"]],
  ["parse_form", L({ ko: "양식 필드·누름틀 분석", en: "Analyze form fields and click-here fields" }), shared, ["path"]],
  ["fill_form", L({ ko: "서식 보존 양식 작성 또는 내장 기안문 작성", en: "Fill a form preserving formatting or create an embedded draft" }), { ...shared, template: { type: "string", enum: ["gian", "gian-simple"] }, values: object, require_unique: { type: "boolean" } }, ["values"]],
  ["patch_document", L({ ko: "수정 Markdown을 새 HWPX/HWP에 반영", en: "Apply edited Markdown to a new HWPX/HWP" }), { ...shared, markdown_path: file, markdown: { type: "string" } }, ["path"]],
  ["extract_profile", L({ ko: "표 서식 프로필 추출", en: "Extract table format profile" }), shared, ["path"]],
  ["generate_document", L({ ko: "Markdown에서 HWPX 작성", en: "Create HWPX from Markdown" }), { path: file, markdown: { type: "string" }, options: object, profile_path: file }, []],
  ["place_seal", L({ ko: "도장·서명 배치", en: "Place seal or signature" }), { ...shared, image_path: file, anchor: { type: "string" }, seal_options: object }, ["path", "image_path", "anchor"]],
  ["render_document", L({ ko: "HWP·HWPX를 SVG 또는 HTML로 저장", en: "Save HWP/HWPX as SVG or HTML" }), { ...shared, format: { type: "string", enum: ["svg", "html"] }, highlights: { type: "array", items: { type: "string" } }, reflow_mode: { type: "string", enum: ["keep", "charAll"] } }, ["path"]],
  ["redact_document", L({ ko: "개인정보 마스킹·잔존 검사", en: "Redact personal information and check residual matches" }), { ...shared, rules: { type: "array", items: { type: "string" } }, mask_char: { type: "string" } }, ["path"]],
  ["crop_regions", L({ ko: "영역 정보를 읽고 SVG 영역 저장", en: "Read region information and save SVG regions" }), shared, ["path"]],
  ["extract_tables", L({ ko: "표 분류·구조·위치 추출", en: "Extract table classification, structure and positions" }), shared, ["path"]],
  ["validate_document", L({ ko: "HWPX 구조 검사", en: "Validate HWPX structure" }), { path: file }, ["path"]],
  ["lint_document", L({ ko: "공문서 표기·문체 검사", en: "Check official document notation and style" }), { path: file }, ["path"]],
];
return definitions.map(([name, description, properties, required]) => ({
  name, description, inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
  annotations: { destructiveHint: false, openWorldHint: false },
}));

}

/** Explicitly started, authenticated loopback-only MCP. Never loads an external executable. */
export class LocalMcpServer {
  private http?: HttpServer;
  private readonly sessions = new Set<Server>();
  private token = "";
  private endpoint = "";
  private starting?: Promise<void>;
  constructor(private readonly execute: (name: string, args: Record<string, unknown>) => Promise<unknown>) {}
  get connection() { return { url: this.endpoint, headers: { Authorization: `Bearer ${this.token}` } }; }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startInternal(): Promise<void> {
    if (this.http) return;
    this.token = randomBytes(32).toString("hex");
    const http = createServer((req, res) => { void (async () => {
      const authorization = String(req.headers.authorization ?? "");
      const expected = `Bearer ${this.token}`;
      const suppliedBytes = Buffer.from(authorization), expectedBytes = Buffer.from(expected);
      if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
        res.writeHead(401); res.end("Authentication required"); return;
      }
      if (req.url !== "/mcp" || req.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) {
        res.writeHead(403); res.end("Invalid local request"); return;
      }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
      let total = 0;
      const parts: Buffer[] = [];
      try {
        for await (const part of req as AsyncIterable<unknown>) {
          if (!Buffer.isBuffer(part) && typeof part !== "string" && !(part instanceof Uint8Array)) throw new Error("Invalid request chunk");
          const chunk = Buffer.from(part);
          total += chunk.byteLength;
          if (total > 2 * 1024 * 1024) { res.writeHead(413); res.end("Request too large"); return; }
          parts.push(chunk);
        }
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const server = new Server({ name: "kordoc-obsidian", version: VERSION }, { capabilities: { tools: {} }, instructions: "All paths are Vault-relative. Output operations create new files; originals are preserved. Local text/formula OCR is opt-in. No model downloads at runtime." });
        this.sessions.add(server);
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: createLocalMcpTools() }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          try {
            if (!createLocalMcpTools().some((t) => t.name === request.params.name)) throw new Error(L({ ko: "지원하지 않는 도구입니다.", en: "Unsupported tool." }));
            const output = await this.execute(request.params.name, request.params.arguments ?? {});
            const text = JSON.stringify(output);
            return { content: [{ type: "text" as const, text: text.length <= 200000 ? text : JSON.stringify({ truncated: true, preview: text.slice(0, 150000), message: L({ ko: "쪽 범위를 좁히거나 청크·표 단위로 요청하세요.", en: "Narrow the page range or request chunks or tables." }) }) }] };
          } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once("close", () => { this.sessions.delete(server); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) { res.writeHead(400); res.end("Invalid MCP request"); } else if (!res.writableEnded) res.end();
      }
    })(); });
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    this.http = http;
    const address = http.address();
    if (address && typeof address === "object") this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    const http = this.http; this.http = undefined;
    await Promise.allSettled([...this.sessions].map((s) => s.close())); this.sessions.clear();
    if (http) await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); });
    this.token = ""; this.endpoint = "";
  }
}
