import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./engine";

const file = { type: "string", description: "볼트 기준 상대 파일 경로" };
const object = { type: "object", additionalProperties: true };
const shared = { path: file, pages: { type: "string" }, password: { type: "string" } };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
  ["parse_document", "문서를 Markdown과 구조 데이터로 읽기 (로컬 OCR 선택 가능)", { ...shared, options: object }, ["path"]],
  ["detect_format", "실제 문서 형식 감지", { path: file }, ["path"]],
  ["parse_metadata", "문서 정보 읽기", shared, ["path"]],
  ["parse_pages", "특정 쪽 본문 읽기", shared, ["path"]],
  ["parse_table", "표 추출", { ...shared, table_index: { type: "integer", minimum: 1 } }, ["path"]],
  ["parse_chunks", "위계·표를 보존한 RAG 청크", shared, ["path"]],
  ["compare_documents", "문단·표 셀 신구 비교", { ...shared, second_path: file }, ["path", "second_path"]],
  ["parse_form", "양식 필드·누름틀 분석", shared, ["path"]],
  ["fill_form", "서식 보존 양식 작성 또는 내장 기안문 작성", { ...shared, template: { type: "string", enum: ["gian", "gian-simple"] }, values: object, require_unique: { type: "boolean" } }, ["values"]],
  ["patch_document", "수정 Markdown을 새 HWPX/HWP에 반영", { ...shared, markdown_path: file, markdown: { type: "string" } }, ["path"]],
  ["extract_profile", "표 서식 프로필 추출", shared, ["path"]],
  ["generate_document", "Markdown에서 HWPX 작성", { path: file, markdown: { type: "string" }, options: object, profile_path: file }, []],
  ["place_seal", "도장·서명 배치", { ...shared, image_path: file, anchor: { type: "string" }, seal_options: object }, ["path", "image_path", "anchor"]],
  ["render_document", "HWP·HWPX를 SVG 또는 HTML로 저장", { ...shared, format: { type: "string", enum: ["svg", "html"] }, highlights: { type: "array", items: { type: "string" } }, reflow_mode: { type: "string", enum: ["keep", "charAll"] } }, ["path"]],
  ["redact_document", "개인정보 마스킹·잔존 검사", { ...shared, rules: { type: "array", items: { type: "string" } }, mask_char: { type: "string" } }, ["path"]],
  ["crop_regions", "영역 정보를 읽고 SVG 영역 저장", shared, ["path"]],
  ["extract_tables", "표 분류·구조·위치 추출", shared, ["path"]],
  ["validate_document", "HWPX 구조 검사", { path: file }, ["path"]],
  ["lint_document", "공문서 표기·문체 검사", { path: file }, ["path"]],
];
export const LOCAL_MCP_TOOLS = definitions.map(([name, description, properties, required]) => ({
  name, description, inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
  annotations: { destructiveHint: false, openWorldHint: false },
}));

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
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LOCAL_MCP_TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          try {
            if (!LOCAL_MCP_TOOLS.some((t) => t.name === request.params.name)) throw new Error("지원하지 않는 도구입니다.");
            const output = await this.execute(request.params.name, request.params.arguments ?? {});
            const text = JSON.stringify(output);
            return { content: [{ type: "text" as const, text: text.length <= 200000 ? text : JSON.stringify({ truncated: true, preview: text.slice(0, 150000), message: "쪽 범위를 좁히거나 청크·표 단위로 요청하세요." }) }] };
          } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once("close", () => { this.sessions.delete(server); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
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
