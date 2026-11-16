import { artifactName } from "./artifact-formats";
import { L, initLocale } from "./locale";
import {
  App,
  moment,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
  Menu,
  Modal,
  type EventRef,
} from "obsidian";
import { resolve } from "node:path";
import { configureEngineDirectory, workerPath } from "./engine-loader";
import { clearLoadedStyleTextCache, configureStyleProfileDirectory } from './style-profile-loader';
import { createStyleProfileApi } from './style-profile-api';
import { notifyWebhook } from "./webhook";
import { waitForNoteMetadata } from "./note-metadata";
import {
  markdownToHwpx,
  VERSION,
  type ExtractedImage,
  type GongmunPresetInput,
  type ParseResult,
  type ParseOptions,
  type MarkdownToHwpxOptions,
  blocksToChunks,
} from "./engine";
import { DocumentToolsModal, askPassword } from "./tool-modal";
import { createToolActions, jsonStringify, offlineParseOptions, parseOffline, parseValues, preciseDocumentFormat, runDocumentTool, type ToolAction, type ToolResult, type ToolRequest } from "./document-tools";
import { ParseWorkerPool } from "./batch-worker";
import { runtimePackError } from "./runtime-paths";
export { engineProbe } from "./engine-probe";
import { createBrowserParseWorker } from "./browser-parse-worker";
import { createIndexText, INDEX_TEXT_EXTRACTOR } from "./index-text";
import { collectVaultImages } from "./vault-images";
import { LocalMcpServer, createLocalMcpTools } from "./local-mcp";
import {
  GONGMUN_PRESETS,
  isMarkdownFilename,
  normalizeGongmunPreset,
  normalizeVaultRelativeFolder,
  preprocessObsidianMarkdown,
  stripFrontmatter,
  type GongmunPresetSetting,
} from "./export-utils";
import { HWPX_VIEW_TYPE, KordocHwpxView } from "./hwpx-view";
import { askImportTarget, type ImportTarget } from "./import-modal";
import { importNoteBaseName, parentFolderOf, resolveImportFolder } from "./import-target";
import {
  KORDOC_PROVIDER_PROTOCOL_VERSION,
  type KordocImporterApi,
} from "./verbex-contract";
import { KordocProviderService } from "./verbex-provider";
import { KordocVerbexRegistrationManager } from "./verbex-adapter";
import { AGENT_CAPABILITY_PROVIDER, PROVIDERS_CHANGED_EVENT, createAgentProvider, type AgentCapabilityProvider } from "./agent-provider";

/** kordoc 가 처리할 수 있는 입력 확장자 (소문자, 점 제외) */
const SUPPORTED_EXTENSIONS = [
  "hwp",
  "hwpx",
  "hwpml",
  "hml",
  "pdf",
  "xls",
  "xlsx",
  "docx",
  "pptx",
];

const KORDOC_LICENSE_TEXT = `MIT License

Copyright (c) 2026 chrisryugj

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

interface KordocSettings {
  /** 변환 결과 .md 를 저장할 볼트 내 폴더 */
  outputFolder: string;
  /** 변환할 때마다 저장 폴더를 묻기 (자동 변환 제외) */
  askImportTarget: boolean;
  /** 마지막으로 선택한 가져오기 폴더 (위치 선택 창의 기본값) */
  lastImportFolder: string;
  /** 원본 문서를 노트와 같은 폴더에 함께 복사 */
  copyOriginal: boolean;
  /** 노트 이름에 원본 확장자 포함 (보고서.hwpx → 보고서.hwpx.md) */
  noteNameWithExtension: boolean;
  /** 추출 이미지를 함께 저장할지 */
  saveImages: boolean;
  /** 이미지 저장 하위 폴더명 (노트 폴더 기준) */
  imageSubfolder: string;
  /** YAML frontmatter(출처/변환일시/메타) 추가 */
  addFrontmatter: boolean;
  /** 변환 직후 노트 열기 */
  openAfterConvert: boolean;
  /** 동일 이름 노트가 있을 때 덮어쓰기 (false 면 -1, -2 … 붙임) */
  overwrite: boolean;
  /** HWPX를 저장할 볼트 기준 상대 폴더 (빈 값이면 원본 노트 폴더) */
  hwpxOutputFolder: string;
  /** HWPX 생성 시 공문서 프리셋 */
  gongmunPreset: GongmunPresetSetting;
  /** 동일 이름 HWPX가 있을 때 덮어쓰기 */
  hwpxOverwrite: boolean;
  /** 수동 편집 시 원본 HWPX 덮어쓰기 허용 (기본 false: 다른 이름으로 저장) */
  hwpxEditOverwrite: boolean;
  outputMode: "markdown" | "json" | "chunks" | "pages";
  parseConfig: ParseOptions;
  concurrency: number;
  browserParseWorker: boolean;
  embedImages: boolean;
  hwpxOptionsJson: string;
  profilePath: string;
  watchFolder: string;
  watchEnabled: boolean;
  webhookUrl: string;
}

const DEFAULT_SETTINGS: KordocSettings = {
  outputFolder: "KorDoc",
  askImportTarget: true,
  lastImportFolder: "",
  copyOriginal: true,
  noteNameWithExtension: true,
  saveImages: true,
  imageSubfolder: "_attachments",
  addFrontmatter: true,
  openAfterConvert: true,
  overwrite: false,
  hwpxOutputFolder: "",
  gongmunPreset: "none",
  hwpxOverwrite: false,
  hwpxEditOverwrite: false,
  outputMode: "markdown", parseConfig: {}, concurrency: 1, browserParseWorker: false, embedImages: true,
  hwpxOptionsJson: "", profilePath: "", watchFolder: "", watchEnabled: false, webhookUrl: "",
};

export default class KordocImporterPlugin extends Plugin {
  settings: KordocSettings;
  api!: KordocImporterApi;
  private verbexProvider?: KordocProviderService;
  private verbexRegistrationManager?: KordocVerbexRegistrationManager;
  private agentProvider?: AgentCapabilityProvider;
  private parsePool?: ParseWorkerPool;
  private poolSize = 0;
  private browserWorkerEnabled = false;
  private readonly watchTimers = new Map<string, number>();
  private readonly conversionTails = new Map<string, Promise<void>>();
  /** 플러그인이 방금 복사한 원본 — 폴더 자동 변환이 다시 집어들지 않도록 잠시 제외 */
  private readonly selfWritten = new Set<string>();
  private localMcp?: LocalMcpServer;
  private unloading = false;

  async onload() {
    initLocale(() => moment.locale());
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath(): string };
    configureEngineDirectory(resolve(adapter.getBasePath(), this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`));
    configureStyleProfileDirectory(resolve(adapter.getBasePath(), this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`));
    await this.loadSettings();
    this.browserWorkerEnabled = this.settings.browserParseWorker;

    this.addCommand({ id: "kordoc-document-tools", name: L({ ko: "문서 도구 열기", en: "Open document tools" }), callback: () => new DocumentToolsModal(this).open() });
    this.addCommand({ id: "kordoc-start-local-mcp", name: L({ ko: "로컬 MCP 서버 시작·연결 정보", en: "Start local MCP server / connection details" }), callback: () => void this.showMcpConnection() });
    this.addCommand({ id: "kordoc-stop-local-mcp", name: L({ ko: "로컬 MCP 서버 중지", en: "Stop local MCP server" }), callback: () => { void this.localMcp?.stop().then(() => new Notice(L({ ko: "KorDoc MCP 서버를 중지했습니다.", en: "KorDoc MCP server stopped." }))); } });
    for (const [action, name] of Object.entries(createToolActions())) {
      this.addCommand({ id: `kordoc-tool-${action}`, name, callback: () => new DocumentToolsModal(this, action as ToolAction).open() });
    }
    // Obsidian also emits "create" for every existing file while the vault loads.
    // Registering before layout-ready re-converted the whole watch folder (and
    // left numbered duplicates) on every app start.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.scheduleWatchedFile(file);
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.scheduleWatchedFile(file);
      }));
    });

    this.verbexProvider = new KordocProviderService(this.app, VERSION, () =>
      this.app.workspace.getLeavesOfType(HWPX_VIEW_TYPE).flatMap(leaf => {
        const view = leaf.view;
        const path = view instanceof KordocHwpxView ? view.getOwnershipPath() : null;
        return path ? [path] : [];
      }),
    );
    this.api = {
      styleProfile: createStyleProfileApi(this.app),
      indexTextVersion: 1,
      indexTextExtractor: INDEX_TEXT_EXTRACTOR,
      indexText: createIndexText(this.app, () => this.getPool()),
      protocolVersion: KORDOC_PROVIDER_PROTOCOL_VERSION,
      provider: this.verbexProvider,
      tools: { list: () => createLocalMcpTools(), execute: (name, args) => this.executeMcpTool(name, args) },
    };
    this.verbexRegistrationManager = new KordocVerbexRegistrationManager(
      this.app,
      this.verbexProvider,
    );
    const workspaceEvents = this.app.workspace as unknown as {
      on(name: "verbex:registry-ready", callback: () => void): EventRef;
    };
    this.registerEvent(workspaceEvents.on("verbex:registry-ready", () => {
      void this.syncVerbexRegistration();
    }));
    void this.syncVerbexRegistration();

    // Self-exposed read tools (agentinterop v1). Any agent host finds them under the Symbol; the provider above is unchanged.
    this.agentProvider = createAgentProvider(this.app, { pluginId: this.manifest.id, name: this.manifest.name, version: this.manifest.version, extensions: SUPPORTED_EXTENSIONS });
    Object.defineProperty(this, AGENT_CAPABILITY_PROVIDER, { value: this.agentProvider, configurable: true, enumerable: false, writable: false });
    this.app.workspace.onLayoutReady(() => this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT));

    // HWPX 전용 읽기/편집 뷰 — HWP5 등 확장자만 .hwpx인 파일은 뷰에서 거부한다.
    // HWPX preview remains available through an explicit command/context menu,
    // but .hwpx is intentionally not registered as Obsidian's default view.
    // A normal left click should be delegated to the operating system's
    // default application.
    this.registerView(
      HWPX_VIEW_TYPE,
      (leaf) => new KordocHwpxView(leaf, this.app, {
        canOverwrite: () => this.settings.hwpxEditOverwrite,
      }),
    );

    // 리본 아이콘 — 외부 파일 선택 변환
    this.addRibbonIcon("file-input", L({ ko: "KorDoc: 외부 문서 변환", en: "KorDoc: Convert external documents" }), () => {
      this.pickAndConvertExternal();
    });

    // 명령어 — 외부 파일 선택 변환
    this.addCommand({
      id: "kordoc-import-external",
      name: L({ ko: "외부 문서를 마크다운으로 변환 (파일 선택)", en: "Convert external documents to Markdown (choose files)" }),
      callback: () => this.pickAndConvertExternal(),
    });

    // 명령어 — 현재 활성 파일 변환 (볼트 내)
    this.addCommand({
      id: "kordoc-convert-active",
      name: L({ ko: "현재 파일을 마크다운으로 변환", en: "Convert current file to Markdown" }),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && this.isSupported(file);
        if (ok && !checking) void this.convertVaultFile(file);
        return ok;
      },
    });

    // HWPX 미리보기 — 등록된 확장자 더블클릭 외에도 명령 팔레트에서 진입 가능
    this.addCommand({
      id: "kordoc-hwpx-preview",
      name: L({ ko: "HWPX 미리보기", en: "HWPX preview" }),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && file.extension.toLowerCase() === "hwpx";
        if (ok && !checking) void this.openHwpxPreview(file);
        return ok;
      },
    });

    this.addCommand({
      id: "kordoc-hwpx-edit-palette",
      name: L({ ko: "HWPX 편집 명령 실행", en: "Run HWPX edit command" }),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KordocHwpxView);
        if (view && !checking) view.openCommandPalette();
        return !!view;
      },
    });

    // 명령어 — 현재 Markdown 편집기 전체를 HWPX로 내보내기
    this.addCommand({
      id: "kordoc-export-hwpx",
      name: L({ ko: "현재 Markdown을 HWPX로 내보내기", en: "Export current Markdown to HWPX" }),
      editorCheckCallback: (checking, editor, info) => {
        const file = info.file;
        const ok = !!file && isMarkdownFilename(file.name);
        if (ok && !checking) {
          void this.exportMarkdownFile(file, editor?.getValue());
        }
        return ok;
      },
    });

    // 파일 탐색기 우클릭 메뉴 — 볼트 내 파일 변환
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === "hwpx") {
          menu.addItem((item) => {
            item
              .setTitle(L({ ko: "KorDoc: HWPX 미리보기", en: "KorDoc: HWPX preview" }))
              .setIcon("layout-dashboard")
              .onClick(() => void this.openHwpxPreview(file));
          });
        }
        if (file instanceof TFile && this.isSupported(file)) {
          menu.addItem((item) => item.setTitle(L({ ko: "KorDoc: 문서 도구", en: "KorDoc: Document tools" })).setIcon("wrench").onClick(() => new DocumentToolsModal(this, "json", file).open()));
          menu.addItem((item) => {
            item
              .setTitle(L({ ko: "KorDoc: 마크다운으로 변환", en: "KorDoc: Convert to Markdown" }))
              .setIcon("file-input")
              .onClick(() => this.convertVaultFile(file));
          });
        }
        if (file instanceof TFile && isMarkdownFilename(file.name)) {
          menu.addItem((item) => {
            item
              .setTitle(L({ ko: "KorDoc: HWPX로 내보내기", en: "KorDoc: Export to HWPX" }))
              .setIcon("file-output")
              .onClick(() => void this.exportMarkdownFile(file));
          });
        }
      })
    );

    // 에디터 우클릭 메뉴 — 선택 영역이 아닌 현재 편집기 전체를 내보냄
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!file || !isMarkdownFilename(file.name)) return;
        menu.addItem((item) => {
          item
            .setTitle(L({ ko: "KorDoc: HWPX로 내보내기", en: "KorDoc: Export to HWPX" }))
            .setIcon("file-output")
            .onClick(() =>
              void this.exportMarkdownFile(file, editor?.getValue())
            );
        });
      })
    );

    this.addSettingTab(new KordocSettingTab(this.app, this));
  }

  onunload() {
    this.unloading = true;
    clearLoadedStyleTextCache();
    this.agentProvider?.dispose();
    this.agentProvider = undefined;
    delete (this as unknown as Record<symbol, unknown>)[AGENT_CAPABILITY_PROVIDER];
    this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
    void this.localMcp?.stop();
    this.parsePool?.dispose();
    for (const timer of this.watchTimers.values()) window.clearTimeout(timer);
    this.watchTimers.clear();
    this.verbexRegistrationManager?.dispose();
    this.verbexRegistrationManager = undefined;
    this.verbexProvider?.dispose();
    this.verbexProvider = undefined;
  }

  private async syncVerbexRegistration(): Promise<void> {
    const manager = this.verbexRegistrationManager;
    if (!manager) return;
    try {
      manager.sync();
    } catch (error) {
      console.error("[KorDoc] Verbex provider registration failed", error);
    }
  }

  async loadSettings() {
    const merged = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<KordocSettings> | null);
    let parseConfig: ParseOptions = {};
    try { parseConfig = offlineParseOptions(merged.parseConfig); } catch { new Notice(L({ ko: "변환 옵션을 기본값으로 복구했습니다. 쪽 범위를 확인하세요.", en: "Conversion options reset to defaults. Check the page range." })); }
    this.settings = {
      ...merged,
      hwpxOutputFolder:
        normalizeVaultRelativeFolder(merged.hwpxOutputFolder) ?? "",
      gongmunPreset: normalizeGongmunPreset(merged.gongmunPreset),
      hwpxOverwrite: merged.hwpxOverwrite === true,
      hwpxEditOverwrite: merged.hwpxEditOverwrite === true,
      outputFolder: normalizeVaultRelativeFolder(merged.outputFolder) ?? "KorDoc",
      askImportTarget: merged.askImportTarget !== false,
      lastImportFolder: resolveImportFolder(merged.lastImportFolder) ?? "",
      copyOriginal: merged.copyOriginal !== false,
      noteNameWithExtension: merged.noteNameWithExtension !== false,
      outputMode: ["markdown", "json", "chunks", "pages"].includes(merged.outputMode) ? merged.outputMode : "markdown",
      parseConfig,
      concurrency: Math.max(1, Math.min(4, Math.floor(Number(merged.concurrency) || 1))),
      browserParseWorker: merged.browserParseWorker === true,
      watchEnabled: merged.watchEnabled === true,
      watchFolder: normalizeVaultRelativeFolder(merged.watchFolder) ?? "",
    };
    delete this.settings.parseConfig.password;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async openHwpxPreview(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).setViewState({ type: HWPX_VIEW_TYPE, state: { file: file.path }, active: true });
  }

  parseOptions(): ParseOptions { return offlineParseOptions(this.settings.parseConfig); }

  async prepareGeneration(source: string, sourcePath?: string): Promise<{ markdown: string; options: MarkdownToHwpxOptions }> {
    const sourceMarkdown = stripFrontmatter(source);
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : undefined;
    const attachments = this.settings.embedImages && file instanceof TFile
      ? await collectVaultImages(this.app, file, sourceMarkdown)
      : { aliases: {}, images: {}, warnings: [] as string[] };
    const extras: unknown = this.settings.hwpxOptionsJson.trim() ? JSON.parse(this.settings.hwpxOptionsJson) : {};
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) throw new Error(L({ ko: "HWPX 고급 설정은 JSON 객체여야 합니다.", en: "Advanced HWPX settings must be a JSON object." }));
    const extraOptions = extras as MarkdownToHwpxOptions;
    const preset = this.settings.gongmunPreset;
    const options: MarkdownToHwpxOptions = { page: extraOptions.page, theme: extraOptions.theme,
      ...(preset === "none" && !extraOptions.gongmun ? {} : { gongmun: { ...(preset === "none" ? {} : { preset: preset as GongmunPresetInput }), ...extraOptions.gongmun } }),
      images: attachments.images, warnings: attachments.warnings };
    if (this.settings.profilePath.trim()) {
      const profileFile = this.app.vault.getAbstractFileByPath(this.settings.profilePath.trim());
      if (!(profileFile instanceof TFile)) throw new Error(L({ ko: "참조할 표 서식 프로필 파일을 찾지 못했습니다.", en: "The reference table format profile file was not found." }));
      options.profile = JSON.parse(await this.app.vault.read(profileFile)) as MarkdownToHwpxOptions["profile"];
    }
    return { markdown: preprocessObsidianMarkdown(sourceMarkdown, attachments.aliases), options };
  }

  private getPool(): ParseWorkerPool {
    if (this.unloading) throw new Error(L({ ko: "플러그인이 종료되었습니다.", en: "The plugin has shut down." }));
    if (!this.parsePool || this.poolSize !== this.settings.concurrency) {
      this.parsePool?.dispose(); this.poolSize = this.settings.concurrency;
      this.parsePool = new ParseWorkerPool(this.poolSize, this.browserWorkerEnabled ? () => createBrowserParseWorker(workerPath()) : undefined);
    }
    return this.parsePool;
  }

  private scheduleWatchedFile(file: TFile): void {
    const folder = normalizeVaultRelativeFolder(this.settings.watchFolder);
    const output = normalizeVaultRelativeFolder(this.settings.outputFolder) ?? "KorDoc";
    if (!this.settings.watchEnabled || !folder || !this.isSupported(file) || !file.path.startsWith(folder + "/")) return;
    if (file.path === output || file.path.startsWith(output + "/")) return;
    if (this.selfWritten.has(file.path)) return;
    window.clearTimeout(this.watchTimers.get(file.path));
    this.watchTimers.set(file.path, window.setTimeout(() => {
      this.watchTimers.delete(file.path);
      const previous = this.conversionTails.get(file.path) ?? Promise.resolve();
      // 자동 변환은 묻지 않고 설정의 저장 폴더를 쓰며, 이미 볼트에 있는 원본은 복사하지 않는다.
      const next = previous.catch(() => {}).then(() => this.convertVaultFile(file, { folder: output, copyOriginal: false }));
      this.conversionTails.set(file.path, next);
      void next.finally(() => { if (this.conversionTails.get(file.path) === next) this.conversionTails.delete(file.path); });
    }, 1000));
  }

  async saveToolResult(name: string, action: ToolAction, result: ToolResult, targetFolder?: string): Promise<{ paths: string[]; reportPath: string }> {
    const TOOL_ACTIONS = createToolActions();
    const folder = normalizeVaultRelativeFolder(targetFolder ?? this.settings.outputFolder);
    if (folder === null) throw new Error(L({ ko: "저장 폴더는 볼트 기준 상대 경로여야 합니다.", en: "The output folder must be a vault-relative path." }));
    await this.ensureFolder(folder);
    const base = sanitizeFilename(stripExtension(name));
    const paths: string[] = [];
    // Every operation creates new files, including patch/fill/redaction; no source overwrite.
    for (const artifact of result.artifacts) {
      const path = await this.createUniqueArtifact(folder, `${base}-${artifact.suffix}`, artifact.extension, artifact.data);
      paths.push(path);
    }
    const report = `# ${createToolActions()[action]}\n\n` + paths.map((p) => p.endsWith(".svg") && action === "preview" ? `![[${p}]]` : `- [[${p}]]`).join("\n\n") + L({ ko: `\n\n## 처리 결과\n\n\`\`\`json\n${jsonStringify(result.report)}\n\`\`\`\n`, en: `

## Processing results

\`\`\`json
${jsonStringify(result.report)}
\`\`\`
` });
    let reportPath: string;
    {
      const TOOL_ACTIONS = createToolActions();
      reportPath = await this.createUniqueArtifact(folder, artifactName("results", [base, TOOL_ACTIONS[action]]), "md", report);
    }
    new Notice(L({ ko: `✅ ${TOOL_ACTIONS[action]} 완료: ${reportPath}`, en: `✅ ${TOOL_ACTIONS[action]} complete: ${reportPath}` }), 6000);
    if (this.settings.openAfterConvert) {
      const reportFile = this.app.vault.getAbstractFileByPath(reportPath);
      if (reportFile instanceof TFile) await this.app.workspace.getLeaf(false).openFile(reportFile);
    }
    return { paths, reportPath };
  }

  private async showMcpConnection(): Promise<void> {
    try {
      this.localMcp ??= new LocalMcpServer((name, args) => this.executeMcpTool(name, args));
      await this.localMcp.start();
      const modal = new Modal(this.app);
      if (typeof modal.setTitle === "function") modal.setTitle(L({ ko: "KorDoc 로컬 MCP 연결", en: "KorDoc local MCP connection" }));
      else modal.titleEl.setText(L({ ko: "KorDoc 로컬 MCP 연결", en: "KorDoc local MCP connection" }));
      modal.contentEl.createEl("p", { text: L({ ko: "이 앱에서 실행 중인 서버에 연결할 주소와 인증 정보입니다. 앱이나 플러그인을 종료하면 서버가 중지됩니다.", en: "Connection address and credentials for the server running in this app. The server stops when the app or plugin closes." }) });
      const config = jsonStringify({ mcpServers: { "kordoc-obsidian": this.localMcp.connection } });
      modal.contentEl.createEl("pre").setText(config);
      new Setting(modal.contentEl).addButton((b) => b.setButtonText(L({ ko: "연결 정보 복사", en: "Copy connection details" })).onClick(() => { void navigator.clipboard.writeText(config); }));
      modal.open();
    } catch (error) { this.reportError(L({ ko: "MCP 서버", en: "MCP server" }), error); }
  }

  private async executeMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const read = async (path: unknown) => {
      const normalized = normalizeVaultRelativeFolder(path);
      const file = normalized ? this.app.vault.getAbstractFileByPath(normalized) : null;
      if (!(file instanceof TFile)) throw new Error(L({ ko: "볼트 기준 상대 파일 경로를 지정하세요.", en: "Specify a vault-relative file path." }));
      return { file, name: file.name, buffer: await this.app.vault.readBinary(file),
        markdown: file.extension === "md" ? await this.app.vault.read(file) : undefined };
    };
    const source = args.path ? await read(args.path) : undefined;
    const options = offlineParseOptions({ ...this.parseOptions(), ...(args.options && typeof args.options === "object" ? args.options : {}),
      ...(args.pages !== undefined ? { pages: args.pages } : {}), ...(args.password !== undefined ? { password: args.password } : {}) });
    if (name === "detect_format") { if (!source) throw new Error(L({ ko: "대상 문서를 지정하세요.", en: "Specify a target document." })); return { format: await preciseDocumentFormat(source.buffer) }; }
    if (name === "parse_document" || name === "parse_metadata") {
      if (!source) throw new Error(L({ ko: "대상 문서를 지정하세요.", en: "Specify a target document." }));
      const result = await parseOffline(source.buffer, { ...options, images: false });
      return name === "parse_metadata" ? { format: result.fileType, metadata: result.metadata, pageCount: result.pageCount, outline: result.outline } : result;
    }
    const actions: Record<string, ToolAction> = {
      parse_pages: "pages", parse_table: "tables", parse_chunks: "chunks", compare_documents: "compare",
      parse_form: "form", fill_form: args.template ? "template" : "fill", patch_document: "patch",
      extract_profile: "profile", generate_document: "generate", place_seal: "seal",
      render_document: args.format === "html" ? "html" : "svg", redact_document: "redact",
      crop_regions: "regions", extract_tables: "tables", validate_document: "validate", lint_document: "lint",
    };
    const action = actions[name];
    if (!action) throw new Error(L({ ko: "지원하지 않는 도구입니다.", en: "Unsupported tool." }));
    if (name === "render_document" && args.format !== undefined && args.format !== "svg" && args.format !== "html") throw new Error(L({ ko: "현재 배포본은 SVG·HTML 렌더를 제공합니다.", en: "This distribution provides SVG and HTML rendering." }));
    const stringify: (value: unknown) => string = String;
    const request: ToolRequest = { action, name: source?.name ?? stringify(args.template ?? artifactName("generatedDocument")), buffer: source?.buffer,
      markdown: source?.markdown, options, template: args.template as string | undefined,
      tableIndex: args.table_index as number | undefined, requireUnique: args.require_unique !== false,
      highlights: Array.isArray(args.highlights) ? args.highlights.map(String) : undefined,
      reflowMode: args.reflow_mode === "charAll" ? "charAll" : "keep",
      redactOptions: { rules: Array.isArray(args.rules) ? args.rules as NonNullable<ToolRequest["redactOptions"]>["rules"] : undefined, maskChar: typeof args.mask_char === "string" ? args.mask_char : undefined },
    };
    if (args.values !== undefined) request.values = parseValues(JSON.stringify(args.values));
    if (args.second_path) request.second = (await read(args.second_path)).buffer;
    if (typeof args.markdown === "string") request.markdown = args.markdown;
    if (args.markdown_path) request.markdown = (await read(args.markdown_path)).markdown;
    if (args.image_path) {
      const image = await read(args.image_path); request.image = new Uint8Array(image.buffer);
      if (!/^(png|jpg|jpeg|bmp|gif)$/i.test(image.file.extension)) throw new Error(L({ ko: "지원하는 도장 이미지 형식을 지정하세요.", en: "Specify a supported seal image format." }));
      request.imageExt = image.file.extension.toLowerCase() as ToolRequest["imageExt"];
      request.anchor = typeof args.anchor === "string" ? args.anchor : undefined;
      request.sealOptions = args.seal_options && typeof args.seal_options === "object" ? args.seal_options : undefined;
    }
    if (action === "generate") {
      request.generateOptions = args.options && typeof args.options === "object" ? args.options : {};
      if (args.profile_path) request.generateOptions.profile = JSON.parse(await this.app.vault.read((await read(args.profile_path)).file)) as MarkdownToHwpxOptions["profile"];
      if (source && request.markdown !== undefined) {
        const attachments = await collectVaultImages(this.app, source.file, request.markdown);
        request.markdown = preprocessObsidianMarkdown(stripFrontmatter(request.markdown), attachments.aliases);
        request.generateOptions.images = attachments.images;
      }
    }
    const result = await runDocumentTool(request);
    const saved = await this.saveToolResult(request.name, action, result);
    return { ...saved, report: result.report, result: result.artifacts.filter((a) => typeof a.data === "string" && a.extension !== "svg" && a.extension !== "html").map((a) => ({ kind: a.extension, data: a.extension === "json" ? JSON.parse(a.data as string) as unknown : a.data })) };
  }

  private async createUniqueArtifact(folder: string, base: string, extension: string, data: string | ArrayBuffer, beforeCreate?: (path: string) => void): Promise<string> {
    for (let i = 0; i < 1000; i++) {
      const path = joinVaultPath(folder, `${sanitizeFilename(base)}${i ? `-${i}` : ""}${extension ? `.${extension}` : ""}`);
      if (await this.app.vault.adapter.exists(path)) continue;
      beforeCreate?.(path);
      try {
        if (typeof data === "string") await this.app.vault.create(path, data); else await this.app.vault.createBinary(path, data);
        return path;
      } catch (error) { if (!await this.app.vault.adapter.exists(path)) throw error; }
    }
    throw new Error(L({ ko: "결과를 저장할 빈 파일 경로를 찾지 못했습니다.", en: "Could not find an unused file path for the results." }));
  }

  private isSupported(file: TFile): boolean {
    return SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase());
  }

  /** 숨김 input[type=file] 로 외부 파일을 받아 변환 (Electron remote 불필요) */
  private pickAndConvertExternal() {
    const input = activeDocument.body.createEl("input", { type: "file" });
    input.multiple = true;
    input.accept = SUPPORTED_EXTENSIONS.map((e) => "." + e).join(",");
    input.hidden = true;

    input.addEventListener("change", () => { void (async () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length === 0) return;
      const target = await this.chooseImportTarget(files.map((f) => f.name));
      if (!target) return;
      let cursor = 0;
      const consume = async () => {
        while (cursor < files.length && !this.unloading) {
          const f = files[cursor++];
          try {
            const buf = await f.arrayBuffer();
            await this.convertBufferAndSave(f.name, buf, target);
          } catch (e) { this.reportError(f.name, e); }
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(files.length, this.settings.concurrency) }, consume));
    })().catch((error: unknown) => this.reportError(L({ ko: "외부 문서 변환", en: "Convert external documents" }), error)); });

    input.click();
  }

  /** 볼트 내 TFile 을 읽어 변환. target 이 없으면 저장 위치를 묻는다. */
  private async convertVaultFile(file: TFile, target?: ImportTarget) {
    try {
      const chosen = target ?? await this.chooseImportTarget([file.name]);
      if (!chosen) return;
      const buf = await this.app.vault.readBinary(file);
      await this.convertBufferAndSave(file.name, buf, chosen, file.path);
    } catch (e) {
      this.reportError(file.name, e);
    }
  }

  /** 저장 위치 선택 창을 띄우거나(설정 켜짐) 설정의 저장 폴더를 그대로 쓴다. 취소하면 null. */
  private async chooseImportTarget(fileNames: string[]): Promise<ImportTarget | null> {
    const fallback = normalizeVaultRelativeFolder(this.settings.outputFolder);
    if (fallback === null) throw new Error(L({ ko: "저장 폴더는 볼트 기준 상대 경로여야 합니다.", en: "The output folder must be a vault-relative path." }));
    const initial: ImportTarget = { folder: this.settings.lastImportFolder || fallback, copyOriginal: this.settings.copyOriginal };
    if (!this.settings.askImportTarget) return { folder: fallback, copyOriginal: this.settings.copyOriginal };
    const target = await askImportTarget(this.app, fileNames, initial);
    if (!target) return null;
    await this.ensureFolder(target.folder);
    if (this.settings.lastImportFolder !== target.folder) {
      this.settings.lastImportFolder = target.folder;
      await this.saveSettings();
    }
    return target;
  }

  /** 원본 문서를 저장 폴더에 복사하고 실제 저장된 파일 이름을 돌려준다. */
  private async copyOriginalFile(folder: string, originalName: string, buffer: ArrayBuffer): Promise<string> {
    const safe = sanitizeFilename(originalName);
    const path = joinVaultPath(folder, safe);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let saved: string;
    if (existing instanceof TFile && this.settings.overwrite) {
      this.markSelfWritten(path);
      await this.app.vault.modifyBinary(existing, buffer);
      saved = path;
    } else {
      const dot = safe.lastIndexOf(".");
      const base = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot + 1) : "";
      saved = await this.createUniqueArtifact(folder, base, ext, buffer, (p) => this.markSelfWritten(p));
    }
    return saved.slice(saved.lastIndexOf("/") + 1);
  }

  private markSelfWritten(path: string): void {
    this.selfWritten.add(path);
    window.setTimeout(() => this.selfWritten.delete(path), 5000);
  }

  /** Markdown 전체(선택 영역 아님)를 HWPX로 생성해 볼트에 저장 */
  private async exportMarkdownFile(file: TFile, editorMarkdown?: string) {
    const notice = new Notice(L({ ko: `HWPX 내보내기 중: ${file.name} …`, en: `Exporting HWPX: ${file.name} …` }), 0);
    try {
      const source = editorMarkdown ?? await this.app.vault.read(file);
      const sourceMarkdown = stripFrontmatter(source);
      const attachments = this.settings.embedImages
        ? await collectVaultImages(this.app, file, sourceMarkdown)
        : { aliases: {}, images: {}, warnings: [] as string[] };
      const markdown = preprocessObsidianMarkdown(sourceMarkdown, attachments.aliases);
      const preset = this.settings.gongmunPreset;
      const extras: unknown = this.settings.hwpxOptionsJson.trim() ? JSON.parse(this.settings.hwpxOptionsJson) : {};
      if (!extras || typeof extras !== "object" || Array.isArray(extras)) throw new Error(L({ ko: "HWPX 고급 설정은 JSON 객체여야 합니다.", en: "Advanced HWPX settings must be a JSON object." }));
      const extraOptions = extras as MarkdownToHwpxOptions;
      const options: MarkdownToHwpxOptions = {
        page: extraOptions.page, theme: extraOptions.theme,
        ...(preset === "none" && !extraOptions.gongmun ? {} : { gongmun: { ...(preset === "none" ? {} : { preset: preset as GongmunPresetInput }), ...extraOptions.gongmun } }),
        images: attachments.images, warnings: attachments.warnings,
      };
      if (this.settings.profilePath.trim()) {
        const profileFile = this.app.vault.getAbstractFileByPath(this.settings.profilePath.trim());
        if (!(profileFile instanceof TFile)) throw new Error(L({ ko: "참조할 표 서식 프로필 파일을 찾지 못했습니다.", en: "The reference table format profile file was not found." }));
        options.profile = JSON.parse(await this.app.vault.read(profileFile)) as MarkdownToHwpxOptions["profile"];
      }
      const buffer = await markdownToHwpx(markdown, options);

      const folder = this.getHwpxOutputFolder(file);
      await this.ensureFolder(folder);
      const baseName = sanitizeFilename(file.basename);
      const outputPath = await this.uniqueBinaryPath(folder, baseName);
      const outputFile = await this.writeHwpx(outputPath, folder, baseName, buffer);

      notice.hide();
      new Notice(L({ ko: `✅ HWPX 내보내기 완료: ${outputFile.path}`, en: `✅ HWPX export complete: ${outputFile.path}` }), 6000);
      if (options.warnings?.length) await this.saveToolResult(file.name, "json", { artifacts: [], report: { warnings: options.warnings } });
    } catch (e) {
      notice.hide();
      this.reportError(L({ ko: `${file.name} HWPX 내보내기`, en: `${file.name} HWPX export` }), e);
    }
  }

  private getHwpxOutputFolder(file: TFile): string {
    const configured = normalizeVaultRelativeFolder(
      this.settings.hwpxOutputFolder,
    );
    if (configured === null) {
      throw new Error(L({ ko: "HWPX 저장 폴더는 볼트 기준 상대 경로만 사용할 수 있습니다.", en: "The HWPX output folder must be a vault-relative path." }));
    }
    if (configured) return configured;
    return normalizeVaultRelativeFolder(file.parent?.path ?? "") ?? "";
  }

  /** 핵심: 바이트 → kordoc 변환 → 볼트 저장 */
  private async convertBufferAndSave(
    originalName: string,
    buffer: ArrayBuffer,
    target: ImportTarget,
    /** 볼트 안의 파일을 변환할 때 그 경로 (이미 저장 폴더에 있으면 원본을 다시 복사하지 않음) */
    sourcePath?: string,
  ) {
    const notice = new Notice(L({ ko: `변환 중: ${originalName} …`, en: `Converting: ${originalName} …` }), 0);
    try {
      const options = this.parseOptions();
      let result: ParseResult;
      // OCR options are explicit; bundled models never download at runtime.
        result = await this.getPool().parse(buffer, options, (current, total) => notice.setMessage(L({ ko: `변환 중: ${originalName} · ${current}/${total}`, en: `Converting: ${originalName} · ${current}/${total}` })));
        if (!result.success && result.code === "ENCRYPTED") {
          const password = await askPassword(this.app);
          if (password === null) { notice.hide(); return; }
          result = await this.getPool().parse(buffer, { ...options, password });
        }

      if (!result.success) {
        notice.hide();
        new Notice(
          L({ ko: `변환 실패: ${originalName}\n${result.error}${
            result.code ? ` (${result.code})` : ""
          }`, en: `Conversion failed: ${originalName}
${result.error}${result.code ? ` (${result.code})` : ""}` }),
          8000
        );
        return;
      }

      if (result.fileType === "pdf" && result.qualitySummary?.needsOcr && result.qualitySummary.totalTextChars === 0 && !result.warnings?.some(w => w.code === "OCR_APPLIED")) {
        throw new Error(options.ocr === false
          ? L({ ko: "텍스트가 없는 스캔 PDF입니다. KorDoc 설정의 ‘로컬 OCR로 스캔·그림 속 글자 인식’을 켜고 다시 변환하세요. 빈 본문 노트는 저장하지 않았습니다.", en: "This scanned PDF has no text. Enable 'Recognize scanned and image text with local OCR' in KorDoc settings and convert again. No empty body note was saved." })
          : L({ ko: "스캔 PDF의 OCR 본문을 얻지 못했습니다. ", en: "Could not obtain OCR text from the scanned PDF. " }) + (result.warnings ?? []).map(w => w.message).join("\n"));
      }

      const folder = normalizeVaultRelativeFolder(target.folder);
      if (folder === null) throw new Error(L({ ko: "저장 폴더는 볼트 기준 상대 경로여야 합니다.", en: "The output folder must be a vault-relative path." }));
      await this.ensureFolder(folder);

      // 원본 복사 — 이름이 겹쳐 -1 등이 붙으면 노트 이름도 그 이름을 따른다.
      let sourceName = originalName;
      let copiedPath: string | undefined;
      if (target.copyOriginal && !(sourcePath && parentFolderOf(sourcePath) === folder)) {
        sourceName = await this.copyOriginalFile(folder, originalName, buffer);
        copiedPath = joinVaultPath(folder, sourceName);
      }
      const baseName = sanitizeFilename(importNoteBaseName(sourceName, this.settings.noteNameWithExtension));

      if (this.settings.outputMode !== "markdown") {
        const mode = this.settings.outputMode;
        const artifacts = mode === "json"
          ? [{ suffix: artifactName("structure"), extension: "json", data: jsonStringify(result) }]
          : mode === "chunks"
          ? [{ suffix: artifactName("chunks"), extension: "json", data: jsonStringify(blocksToChunks(result.blocks, { includeTableCells: true })) }]
          : (result.pages ?? []).map((page) => ({ suffix: artifactName("page", [page.pageNumber]), extension: "md", data: page.markdown }));
        if (!artifacts.length) throw new Error(L({ ko: "이 문서는 쪽별 본문을 제공하지 않습니다.", en: "This document does not provide page-by-page text." }));
        const saved = await this.saveToolResult(sourceName, mode, { artifacts, report: { format: result.fileType, warnings: result.warnings, qualitySummary: result.qualitySummary } }, folder);
        await this.notifyWebhook(originalName, saved.reportPath, result.fileType);
        notice.hide(); return;
      }

      // 이미지 저장 + 마크다운 링크 보정
      let markdown = result.markdown;
      const images = result.images ?? [];
      if (this.settings.saveImages && images.length > 0) {
        markdown = await this.saveImages(folder, baseName, markdown, images);
      }

      if (this.settings.addFrontmatter) {
        markdown = buildFrontmatter(originalName, result) + markdown;
      }

      const notePath = await this.uniqueNotePath(folder, baseName);
      const created = await this.writeNote(notePath, markdown);

      notice.hide();
      const imgMsg = images.length > 0 && this.settings.saveImages
        ? L({ ko: ` (이미지 ${images.length}개)`, en: ` (${images.length} images)` })
        : "";
      const warnMsg =
        result.warnings && result.warnings.length > 0
          ? L({ ko: ` · 경고 ${result.warnings.length}건`, en: ` · ${result.warnings.length} warnings` })
          : "";
      const copyMsg = copiedPath ? L({ ko: `\n원본 복사: ${copiedPath}`, en: `
Source copy: ${copiedPath}` }) : "";
      new Notice(L({ ko: `✅ 변환 완료: ${created.path}${imgMsg}${warnMsg}${copyMsg}`, en: `✅ Conversion complete: ${created.path}${imgMsg}${warnMsg}${copyMsg}` }), 6000);
      if (result.warnings?.length || result.qualitySummary?.needsOcr) {
        await this.createUniqueArtifact(folder, artifactName("diagnostics", [baseName]), "json", jsonStringify({ engineVersion: VERSION, parseOptions: { ocr: options.ocr ?? false, formulaOcr: options.formulaOcr ?? false }, warnings: result.warnings, pageQuality: result.pageQuality, qualitySummary: result.qualitySummary, metadata: result.metadata }));
      }

      await this.notifyWebhook(originalName, created.path, result.fileType);

      if (this.settings.openAfterConvert) {
        if (await waitForNoteMetadata(this.app.metadataCache, created)) {
          await this.app.workspace.getLeaf(false).openFile(created);
        } else {
          new Notice(L({ ko: `변환 파일을 저장했습니다. Obsidian 메타데이터 준비가 늦어 자동 열기를 생략했습니다: ${created.path}`, en: `The converted file was saved. Automatic opening was skipped because Obsidian metadata was not ready: ${created.path}` }), 6000);
        }
      }
    } catch (e) {
      notice.hide();
      this.reportError(originalName, e);
    }
  }

  /** Optional, explicitly configured completion notification. */
  private async notifyWebhook(source: string, output: string, format: string): Promise<void> {
    if (!this.settings.webhookUrl.trim()) return;
    try {
      await notifyWebhook(requestUrl, this.settings.webhookUrl, { source, output, format, success: true });
    } catch (error) { new Notice(L({ ko: `문서 변환은 완료했지만 웹훅 알림에 실패했습니다: ${String(error)}`, en: `Document conversion completed, but the webhook notification failed: ${String(error)}` }), 6000); }
  }

  /** 추출 이미지를 볼트에 쓰고, 마크다운 내 파일명 참조를 상대경로로 교체 */
  private async saveImages(
    noteFolder: string,
    baseName: string,
    markdown: string,
    images: ExtractedImage[]
  ): Promise<string> {
    const sub = normalizeVaultRelativeFolder(this.settings.imageSubfolder);
    if (sub === null) throw new Error(L({ ko: "이미지 폴더는 볼트 기준 상대 경로여야 합니다.", en: "The image folder must be a vault-relative path." }));
    const imgFolder = normalizePath(
      sub ? `${noteFolder}/${sub}/${baseName}` : noteFolder
    );
    await this.ensureFolder(imgFolder);

    let md = markdown;
    for (const img of images) {
      const targetPath = await this.createUniqueArtifact(imgFolder, stripExtension(img.filename), img.filename.split(".").pop() || "bin", toArrayBuffer(img.data));
      // kordoc 마크다운은 파일명(예: image_001.png)으로 참조 → 상대경로로 교체
      const rel = noteFolder ? targetPath.slice(noteFolder.length + 1) : targetPath;
      md = replaceImageRef(md, img.filename, rel);
    }
    return md;
  }

  private async ensureFolder(path: string) {
    const normalized = normalizeVaultRelativeFolder(path);
    if (normalized === null) {
      throw new Error(L({ ko: "볼트 폴더 경로가 올바르지 않습니다.", en: "Invalid vault folder path." }));
    }
    if (!normalized) return;

    let current = "";
    for (const part of normalized.split("/")) {
      current = joinVaultPath(current, part);
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(L({ ko: `출력 폴더 경로가 파일과 충돌합니다: ${current}`, en: `The output folder path conflicts with a file: ${current}` }));
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const after = this.app.vault.getAbstractFileByPath(current);
        if (after instanceof TFolder) continue;
        throw error;
      }
    }
  }

  private async uniqueNotePath(
    folder: string,
    baseName: string
  ): Promise<string> {
    const safe = sanitizeFilename(baseName);
    const first = joinVaultPath(folder, `${safe}.md`);
    if (this.settings.overwrite) return first;
    if (!(await this.app.vault.adapter.exists(first))) return first;
    for (let i = 1; i < 1000; i++) {
      const p = joinVaultPath(folder, `${safe}-${i}.md`);
      if (!(await this.app.vault.adapter.exists(p))) return p;
    }
    return joinVaultPath(folder, `${safe}-${Date.now()}.md`);
  }

  private async uniqueBinaryPath(
    folder: string,
    baseName: string,
  ): Promise<string> {
    const safe = sanitizeFilename(baseName);
    for (let i = 0; i < 1000; i++) {
      const suffix = i === 0 ? "" : `-${i}`;
      const path = joinVaultPath(folder, `${safe}${suffix}.hwpx`);
      const abstract = this.app.vault.getAbstractFileByPath(path);
      if (abstract instanceof TFolder) {
        throw new Error(L({ ko: `HWPX 출력 경로가 폴더와 충돌합니다: ${path}`, en: `The HWPX output path conflicts with a folder: ${path}` }));
      }
      if (this.settings.hwpxOverwrite && i === 0) return path;
      if (!abstract && !(await this.app.vault.adapter.exists(path))) return path;
    }
    throw new Error(L({ ko: "같은 이름의 HWPX 파일이 너무 많습니다.", en: "Too many HWPX files have the same name." }));
  }

  private async writeHwpx(
    path: string,
    folder: string,
    baseName: string,
    data: ArrayBuffer,
  ): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      throw new Error(L({ ko: `HWPX 출력 경로가 폴더와 충돌합니다: ${path}`, en: `The HWPX output path conflicts with a folder: ${path}` }));
    }
    if (existing instanceof TFile) {
      if (!this.settings.hwpxOverwrite) {
        throw new Error(L({ ko: `HWPX 파일이 이미 존재합니다: ${path}`, en: `An HWPX file already exists: ${path}` }));
      }
      await this.app.vault.modifyBinary(existing, data);
      return existing;
    }

    try {
      return await this.app.vault.createBinary(path, data);
    } catch (error) {
      if (this.settings.hwpxOverwrite) {
        const appeared = this.app.vault.getAbstractFileByPath(path);
        if (appeared instanceof TFile) {
          await this.app.vault.modifyBinary(appeared, data);
          return appeared;
        }
        throw error;
      }
      if (!(await this.app.vault.adapter.exists(path))) throw error;
    }

    // 존재 확인과 createBinary 사이에 다른 작업이 만든 파일은 다음 suffix로 회피한다.
    const safe = sanitizeFilename(baseName);
    for (let i = 1; i < 1000; i++) {
      const candidate = joinVaultPath(folder, `${safe}-${i}.hwpx`);
      const abstract = this.app.vault.getAbstractFileByPath(candidate);
      if (abstract instanceof TFolder) {
        throw new Error(L({ ko: `HWPX 출력 경로가 폴더와 충돌합니다: ${candidate}`, en: `The HWPX output path conflicts with a folder: ${candidate}` }));
      }
      if (abstract || await this.app.vault.adapter.exists(candidate)) continue;
      try {
        return await this.app.vault.createBinary(candidate, data);
      } catch (error) {
        if (await this.app.vault.adapter.exists(candidate)) continue;
        throw error;
      }
    }
    throw new Error(L({ ko: "HWPX 출력 파일을 생성할 빈 경로를 찾지 못했습니다.", en: "Could not find an unused path for the HWPX output file." }));
  }

  private async writeNote(path: string, content: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile && this.settings.overwrite) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    if (!this.settings.overwrite) {
      const slash = path.lastIndexOf("/");
      const folder = slash >= 0 ? path.slice(0, slash) : "";
      const base = stripExtension(path.slice(slash + 1));
      for (let i = 0; i < 1000; i++) {
        const candidate = joinVaultPath(folder, `${base}${i ? `-${i}` : ""}.md`);
        if (await this.app.vault.adapter.exists(candidate)) continue;
        try { return await this.app.vault.create(candidate, content); }
        catch (error) { if (!await this.app.vault.adapter.exists(candidate)) throw error; }
      }
      throw new Error(L({ ko: "노트를 저장할 빈 파일 경로를 찾지 못했습니다.", en: "Could not find an unused path to save the note." }));
    }
    return await this.app.vault.create(path, content);
  }

  private reportError(name: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(L({ ko: `[KorDoc] ${name} 변환 오류:`, en: `[KorDoc] ${name} conversion error:` }), e);
    new Notice(L({ ko: `변환 오류: ${name}\n${msg}`, en: `Conversion error: ${name}
${msg}` }), 8000);
  }
}

/* ---------- 순수 헬퍼 ---------- */

function joinVaultPath(folder: string, name: string): string {
  return normalizePath(folder ? `${folder}/${name}` : name);
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function sanitizeFilename(name: string): string {
  // 볼트 경로에서 금지/문제되는 문자 제거
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() ||
    artifactName("convertedDocument");
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** 마크다운 이미지 참조(파일명)를 새 상대경로로 교체. 정규식 특수문자 이스케이프. */
function replaceImageRef(md: string, filename: string, rel: string): string {
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // ![alt](filename) / ![alt](<filename>) 형태 모두 대응
  const re = new RegExp(`(\\]\\(<?)${esc}(>?\\))`, "g");
  return md.replace(re, `$1${rel}$2`);
}

function buildFrontmatter(originalName: string, result: ParseResult): string {
  const lines: string[] = ["---"];
  lines.push(`source: "${yamlEscape(originalName)}"`);
  if (result.success) {
    lines.push(`format: ${result.fileType}`);
    if (result.pageCount != null) lines.push(`pages: ${result.pageCount}`);
    const meta = result.metadata;
    if (meta?.title) lines.push(`title: "${yamlEscape(meta.title)}"`);
    if (meta?.author) lines.push(`author: "${yamlEscape(meta.author)}"`);
    if (meta?.createdAt) lines.push(`created: "${yamlEscape(meta.createdAt)}"`);
  }
  lines.push(`converted: ${new Date().toISOString()}`);
  lines.push(`tool: "kordoc ${VERSION}"`);
  lines.push("---", "", "");
  return lines.join("\n");
}

function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* ---------- 설정 탭 ---------- */

type KordocSettingRow =
  | { kind: "setting"; name: string; desc?: string; build: (setting: Setting) => void }
  | { kind: "footer"; name: string; render: (container: HTMLElement) => void };

const settingsHeading = () => L({ ko: "KorDoc 문서 변환기 설정", en: "KorDoc document converter settings" });

class KordocSettingTab extends PluginSettingTab {
  plugin: KordocImporterPlugin;

  constructor(app: App, plugin: KordocImporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private settingRows(): KordocSettingRow[] {
    const rows: KordocSettingRow[] = [];
    const addRow = (name: string, desc: string | undefined, build: (setting: Setting) => void) => { rows.push({ kind: "setting", name, desc, build }); };
    addRow(L({ ko: "저장 폴더", en: "Output folder" }), L({ ko: "변환된 마크다운을 저장할 볼트 내 기본 폴더 경로 (위치 선택 창을 끄거나 폴더 자동 변환 시 사용)", en: "Default folder path in the vault for converted Markdown (used when the location dialog is disabled or for automatic folder conversion)" }), (setting) => { setting
      .addText((t) =>
        t
          .setPlaceholder("KorDoc")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (v) => {
            this.plugin.settings.outputFolder = v.trim() || "KorDoc";
            await this.plugin.saveSettings();
          })
      ); });

    addRow(L({ ko: "변환할 때 저장 위치 묻기", en: "Ask for output location when converting" }), L({ ko: "켜면 변환 전에 볼트 안 저장 폴더를 고르고, 그 아래 새 폴더를 만들 수 있습니다. 끄면 위 저장 폴더를 씁니다 (폴더 자동 변환은 항상 위 저장 폴더)", en: "Choose an output folder in the vault before conversion and optionally create a subfolder. When disabled, use the output folder above (automatic folder conversion always uses that folder)" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.askImportTarget).onChange(async (v) => {
          this.plugin.settings.askImportTarget = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "원본 파일 함께 복사", en: "Copy source files too" }), L({ ko: "변환 전 원본 문서를 노트와 같은 폴더에 복사합니다 (위치 선택 창의 기본값). 이미 그 폴더에 있는 볼트 파일과 폴더 자동 변환은 복사하지 않습니다", en: "Copy source documents into the note folder before conversion (default for the location dialog). Vault files already in that folder and automatic folder conversion are not copied" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.copyOriginal).onChange(async (v) => {
          this.plugin.settings.copyOriginal = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "노트 이름에 원본 확장자 포함", en: "Include source extension in note names" }), L({ ko: "켜면 보고서.hwpx → 보고서.hwpx.md, 끄면 보고서.md", en: "Enabled: report.hwpx → report.hwpx.md; disabled: report.md" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.noteNameWithExtension).onChange(async (v) => {
          this.plugin.settings.noteNameWithExtension = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "이미지 추출 저장", en: "Save extracted images" }), L({ ko: "문서에 포함된 이미지를 함께 볼트에 저장하고 링크를 연결합니다", en: "Save embedded document images to the vault and link them" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveImages).onChange(async (v) => {
          this.plugin.settings.saveImages = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "이미지 하위 폴더", en: "Image subfolder" }), L({ ko: "이미지를 저장할 하위 폴더명 (저장 폴더 기준, 비우면 노트와 같은 폴더)", en: "Subfolder name for images, relative to the output folder (leave empty to use the note folder)" }), (setting) => { setting
      .addText((t) =>
        t
          .setPlaceholder("_attachments")
          .setValue(this.plugin.settings.imageSubfolder)
          .onChange(async (v) => {
            this.plugin.settings.imageSubfolder = v.trim();
            await this.plugin.saveSettings();
          })
      ); });

    addRow(L({ ko: "Frontmatter 추가", en: "Add frontmatter" }), L({ ko: "출처 파일명·포맷·변환일시·메타데이터를 YAML frontmatter로 추가", en: "Add source filename, format, conversion timestamp and metadata as YAML frontmatter" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.addFrontmatter).onChange(async (v) => {
          this.plugin.settings.addFrontmatter = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "변환 후 노트 열기", en: "Open note after conversion" }), undefined, (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openAfterConvert).onChange(async (v) => {
          this.plugin.settings.openAfterConvert = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "같은 이름 노트 덮어쓰기", en: "Overwrite notes with the same name" }), L({ ko: "끄면 기존 노트를 보존하고 -1, -2 … 를 붙여 새로 만듭니다", en: "When disabled, preserve existing notes and create new ones with -1, -2 …" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overwrite).onChange(async (v) => {
          this.plugin.settings.overwrite = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "HWPX 저장 폴더", en: "HWPX output folder" }), L({ ko: "볼트 기준 상대 경로. 비우면 원본 Markdown 노트와 같은 폴더에 저장합니다", en: "Vault-relative path. Leave empty to save beside the source Markdown note" }), (setting) => { setting
      .addText((t) =>
        t
          .setPlaceholder(L({ ko: "(원본 노트 폴더)", en: "(Source note folder)" }))
          .setValue(this.plugin.settings.hwpxOutputFolder)
          .onChange(async (v) => {
            const normalized = normalizeVaultRelativeFolder(v);
            if (normalized === null) {
              new Notice(L({ ko: "HWPX 저장 폴더는 절대 경로와 .. 경로를 사용할 수 없습니다.", en: "The HWPX output folder cannot use absolute paths or .. paths." }), 5000);
              t.setValue(this.plugin.settings.hwpxOutputFolder);
              return;
            }
            this.plugin.settings.hwpxOutputFolder = normalized;
            await this.plugin.saveSettings();
          })
      ); });

    addRow(L({ ko: "공문서 프리셋", en: "Official document preset" }), L({ ko: "HWPX 생성 시 적용할 문서 형식. 기본값은 범용 Markdown 변환입니다", en: "Document format applied when generating HWPX. The default is general Markdown conversion" }), (setting) => { setting
      .addDropdown((d) => {
        d.addOption("none", L({ ko: "범용 (프리셋 없음)", en: "General (no preset)" }));
        const labels: Record<string, string> = {
          official: L({ ko: "기안문", en: "Draft" }),
          report: L({ ko: "보고서", en: "Report" }),
          plan: L({ ko: "계획서", en: "Plan" }),
          notice: L({ ko: "통지", en: "Notice" }),
          minutes: L({ ko: "회의록", en: "Minutes" }),
          gaejosik: L({ ko: "개조식", en: "Bullet-style report" }),
          press: L({ ko: "보도자료", en: "Press release" }),
          ministry: L({ ko: "업무보고", en: "Business report" }),
          bangchim: L({ ko: "서울방침", en: "Seoul policy" }),
        };
        for (const preset of GONGMUN_PRESETS) {
          d.addOption(preset, labels[preset]);
        }
        d.setValue(this.plugin.settings.gongmunPreset);
        d.onChange(async (v) => {
          this.plugin.settings.gongmunPreset = normalizeGongmunPreset(v);
          await this.plugin.saveSettings();
        });
      }); });

    addRow(L({ ko: "같은 이름 HWPX 덮어쓰기", en: "Overwrite HWPX with the same name" }), L({ ko: "끄면 기존 .hwpx를 보존하고 -1, -2 … 를 붙여 새로 만듭니다", en: "When disabled, preserve existing .hwpx files and create new ones with -1, -2 …" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.hwpxOverwrite).onChange(async (v) => {
          this.plugin.settings.hwpxOverwrite = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "수동 편집 시 원본 HWPX 덮어쓰기", en: "Overwrite source HWPX during manual editing" }), L({ ko: "기본값은 -편집.hwpx로 저장합니다. 켜면 편집 결과가 원본에 직접 저장됩니다", en: "By default, save as -edited.hwpx. When enabled, save edits directly to the source" }), (setting) => { setting
      .addToggle((t) =>
        t.setValue(this.plugin.settings.hwpxEditOverwrite).onChange(async (v) => {
          this.plugin.settings.hwpxEditOverwrite = v;
          await this.plugin.saveSettings();
        })
      ); });

    addRow(L({ ko: "변환 결과 형식", en: "Conversion output format" }), undefined, (setting) => { setting.addDropdown((d) => d
      .addOptions({ markdown: L({ ko: "Markdown 노트", en: "Markdown note" }), json: L({ ko: "구조화 JSON", en: "Structured JSON" }), chunks: L({ ko: "RAG 청크 JSON", en: "RAG chunks JSON" }), pages: L({ ko: "쪽별 Markdown", en: "Markdown by page" }) })
      .setValue(this.plugin.settings.outputMode).onChange(async (v) => { this.plugin.settings.outputMode = v as KordocSettings["outputMode"]; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "변환할 쪽 범위", en: "Page range to convert" }), L({ ko: "비우면 전체 문서. 예: 1-3,5", en: "Leave empty for the entire document. Example: 1-3,5" }), (setting) => { setting.addText((t) => t
      .setValue(String(this.plugin.settings.parseConfig.pages ?? "")).onChange(async (v) => {
        try { this.plugin.settings.parseConfig = offlineParseOptions({ ...this.plugin.settings.parseConfig, pages: v }); await this.plugin.saveSettings(); }
        catch (error) { new Notice(String(error)); }
      })); });
    const parseToggles: Array<[keyof ParseOptions, string, boolean]> = [
      ["ocr", L({ ko: "로컬 OCR로 스캔·그림 속 글자 인식", en: "Recognize scanned and image text with local OCR" }), false],
      ["formulaOcr", L({ ko: "로컬 수식 OCR (LaTeX)", en: "Local formula OCR (LaTeX)" }), false],
      ["plain", L({ ko: "평문 위주 Markdown", en: "Plain-text-oriented Markdown" }), false], ["htmlTables", L({ ko: "모든 표를 HTML로 출력", en: "Output all tables as HTML" }), false],
      ["keepTrailingEmptyCols", L({ ko: "표 끝의 빈 열 보존", en: "Preserve trailing empty table columns" }), false], ["keepEmptyParagraphs", L({ ko: "빈 문단 보존", en: "Preserve empty paragraphs" }), false],
      ["includeFieldPlaceholders", L({ ko: "누름틀 안내문 출력", en: "Include click-here field prompts" }), false], ["dedupeRunningHeaders", L({ ko: "반복 러닝 헤더 제거", en: "Remove repeated running headers" }), false],
      ["classifyTables", L({ ko: "표의 의미·레이아웃 분류 추가", en: "Add table semantic and layout classification" }), false], ["inlineImages", L({ ko: "HWP5 이미지를 본문에 인라인", en: "Inline HWP5 images in the body" }), false],
      ["images", L({ ko: "변환 시 이미지 데이터 추출", en: "Extract image data during conversion" }), true], ["tables", L({ ko: "PDF 표 감지", en: "Detect PDF tables" }), true],
      ["removeHeaderFooter", L({ ko: "PDF 머리글·바닥글 제거", en: "Remove PDF headers and footers" }), true],
    ];
    for (const [key, label, defaultValue] of parseToggles) addRow(label, undefined, (setting) => { setting.addToggle((t) => t
      .setValue((this.plugin.settings.parseConfig[key] as boolean | undefined) ?? defaultValue)
      .onChange(async (v) => {
        if (v && (key === "ocr" || key === "formulaOcr")) {
          const error = runtimePackError();
          if (error) { new Notice(error); t.setValue(false); return; }
        }
        this.plugin.settings.parseConfig = offlineParseOptions({ ...this.plugin.settings.parseConfig, [key]: v }); await this.plugin.saveSettings();
      })); });
    addRow(L({ ko: "위·아래첨자 표시", en: "Superscript and subscript display" }), undefined, (setting) => { setting.addDropdown((d) => d.addOptions({ auto: L({ ko: "포맷별 기본값", en: "Format defaults" }), on: L({ ko: "첨자 태그 보존", en: "Preserve script tags" }), off: L({ ko: "평문", en: "Plain text" }) })
      .setValue(this.plugin.settings.parseConfig.scriptTags === undefined ? "auto" : this.plugin.settings.parseConfig.scriptTags ? "on" : "off")
      .onChange(async (v) => { const config = { ...this.plugin.settings.parseConfig }; delete config.scriptTags; if (v !== "auto") config.scriptTags = v === "on"; this.plugin.settings.parseConfig = config; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "레이아웃 표 처리", en: "Layout table handling" }), undefined, (setting) => { setting.addDropdown((d) => d.addOptions({ visual: L({ ko: "보이는 구조에 맞춰 정리", en: "Clean up to match the visible structure" }), keep: L({ ko: "원본 표 구조 보존", en: "Preserve original table structure" }) })
      .setValue(this.plugin.settings.parseConfig.layoutTables ?? "visual").onChange(async (v) => { this.plugin.settings.parseConfig.layoutTables = v as "visual" | "keep"; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "동시 변환 파일 수", en: "Concurrent file conversions" }), L({ ko: "1~4개. 파일 수만큼 메모리 사용량이 늘어납니다.", en: "1–4 files. Memory usage increases with the file count." }), (setting) => { setting.addDropdown((d) => d
      .addOptions({ "1": "1", "2": "2", "3": "3", "4": "4" }).setValue(String(this.plugin.settings.concurrency))
      .onChange(async (v) => { this.plugin.settings.concurrency = Number(v); await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "격리 변환 워커 (실험)", en: "Isolated conversion worker (experimental)" }), L({ ko: "변환을 별도 워커에서 시도합니다. 환경에 따라 시작하지 못하면 기존 방식으로 처리합니다. 플러그인을 다시 켠 뒤 적용됩니다.", en: "Try converting in a separate worker. If the environment cannot start it, use the existing method. Takes effect after re-enabling the plugin." }), (setting) => { setting.addToggle((t) => t
      .setValue(this.plugin.settings.browserParseWorker).onChange(async (v) => { this.plugin.settings.browserParseWorker = v; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "볼트 첨부 이미지를 HWPX에 삽입", en: "Embed vault attachment images in HWPX" }), undefined, (setting) => { setting.addToggle((t) => t.setValue(this.plugin.settings.embedImages)
      .onChange(async (v) => { this.plugin.settings.embedImages = v; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "참조 표 서식 프로필", en: "Reference table format profile" }), L({ ko: "‘표 서식 프로필 추출’로 만든 JSON의 볼트 경로", en: "Vault path to JSON created by 'Extract table format profile'" }), (setting) => { setting.addText((t) => t
      .setValue(this.plugin.settings.profilePath).onChange(async (v) => { this.plugin.settings.profilePath = normalizeVaultRelativeFolder(v) ?? ""; await this.plugin.saveSettings(); })); });

    let parsedConfig: unknown = {};
    try { parsedConfig = JSON.parse(this.plugin.settings.hwpxOptionsJson || "{}"); } catch { /* The JSON editor retains invalid text until corrected. */ }
    const exportConfig = parsedConfig && typeof parsedConfig === "object" && !Array.isArray(parsedConfig) ? parsedConfig as MarkdownToHwpxOptions : {};
    const setExport = async (group: string, key: string, value: unknown) => {
      try {
        const config: unknown = JSON.parse(this.plugin.settings.hwpxOptionsJson || "{}");
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(L({ ko: "고급 HWPX 설정을 JSON 객체로 수정하세요.", en: "Edit advanced HWPX settings as a JSON object." }));
        const record = config as Record<string, unknown>;
        record[group] = { ...Object(record[group]), [key]: value };
        this.plugin.settings.hwpxOptionsJson = JSON.stringify(config, null, 2); await this.plugin.saveSettings();
      } catch (error) { new Notice(String(error)); }
    };
    addRow(L({ ko: "HWPX 용지", en: "HWPX paper size" }), undefined, (setting) => { setting.addDropdown((d) => d.addOptions({ A4: "A4", A3: "A3", B4: "B4", B5: "B5", Letter: "Letter" })
      .setValue((exportConfig.page?.size ?? "A4") as string).onChange((v) => setExport("page", "size", v))); });
    addRow(L({ ko: "HWPX 용지 방향", en: "HWPX paper orientation" }), undefined, (setting) => { setting.addDropdown((d) => d.addOptions({ portrait: L({ ko: "세로", en: "Portrait" }), landscape: L({ ko: "가로", en: "Landscape" }) })
      .setValue(exportConfig.page?.orientation ?? "portrait").onChange((v) => setExport("page", "orientation", v))); });
    addRow(L({ ko: "HWPX 단 수", en: "HWPX columns" }), undefined, (setting) => { setting.addDropdown((d) => { for (let i = 1; i <= 8; i++) d.addOption(String(i), String(i)); d
      .setValue(String(exportConfig.page?.columns ?? 1)).onChange((v) => setExport("page", "columns", Number(v))); }); });
    for (const [key, label] of [["header", L({ ko: "HWPX 머리말", en: "HWPX header" })], ["footer", L({ ko: "HWPX 꼬리말", en: "HWPX footer" })]] as const) addRow(label, undefined, (setting) => { setting.addText((t) => t
      .setValue(exportConfig.page?.[key] ?? "").onChange((v) => setExport("page", key, v))); });
    for (const [key, label, min, max] of [["bodyPt", L({ ko: "공문서 본문 크기 (pt)", en: "Official document body size (pt)" }), 6, 60], ["lineSpacing", L({ ko: "공문서 줄간격 (%)", en: "Official document line spacing (%)" }), 50, 500]] as const) addRow(label, L({ ko: "비우면 프리셋 기본값", en: "Leave empty for the preset default" }), (setting) => { setting.addText((t) => t.setValue(String(exportConfig.gongmun?.[key] ?? ""))
        .onChange(async (v) => { if (v === "") { await setExport("gongmun", key, undefined); return; } const n = Number(v); if (Number.isFinite(n) && n >= min && n <= max) await setExport("gongmun", key, n); })); });
    addRow(L({ ko: "공문서 글꼴 계열", en: "Official document font family" }), undefined, (setting) => { setting.addDropdown((d) => d.addOptions({ auto: L({ ko: "프리셋 기본값", en: "Preset default" }), myeongjo: L({ ko: "명조", en: "Serif" }), gothic: L({ ko: "고딕", en: "Sans serif" }) })
      .setValue(exportConfig.gongmun?.bodyFont ?? "auto").onChange((v) => setExport("gongmun", "bodyFont", v === "auto" ? undefined : v))); });
    addRow(L({ ko: "결재란 직위", en: "Approval positions" }), L({ ko: "쉼표로 구분. 예: 담당,팀장,과장", en: "Comma-separated. Example: Officer,Team lead,Director" }), (setting) => { setting.addText((t) => t
      .setValue(Array.isArray(exportConfig.gongmun?.approval) ? exportConfig.gongmun.approval.join(",") : "")
      .onChange((v) => setExport("gongmun", "approval", v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))); });
    for (const [key, label] of [["toc", L({ ko: "공문서 목차", en: "Official document table of contents" })], ["pageNumbers", L({ ko: "공문서 쪽번호", en: "Official document page numbers" })], ["cover", L({ ko: "공문서 표지", en: "Official document cover" })]]) addRow(label, undefined, (setting) => { setting.addDropdown((d) => d
      .addOptions({ auto: L({ ko: "프리셋 기본값", en: "Preset default" }), on: L({ ko: "포함", en: "Include" }), off: L({ ko: "생략", en: "Omit" }) }).setValue(exportConfig.gongmun?.[key] === undefined ? "auto" : exportConfig.gongmun[key] ? "on" : "off")
      .onChange((v) => setExport("gongmun", key, v === "auto" ? undefined : v === "on"))); });
    addRow(L({ ko: "HWPX 고급 설정 (JSON)", en: "Advanced HWPX settings (JSON)" }), L({ ko: "page·theme·gongmun의 개별 서식. 표지 기관명·여백·항목별 글꼴 등도 지정할 수 있습니다.", en: "Individual page, theme and gongmun formatting. You can also specify the cover organization, margins and per-item fonts." }), (setting) => { setting.addTextArea((t) => t
      .setValue(this.plugin.settings.hwpxOptionsJson).setPlaceholder(L({ ko: '{"gongmun":{"cover":{"org":"기관명"}}}', en: "{\"gongmun\":{\"cover\":{\"org\":\"Organization\"}}}" }))
      .onChange(async (v) => { this.plugin.settings.hwpxOptionsJson = v; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "자동 변환할 볼트 폴더", en: "Vault folder for automatic conversion" }), L({ ko: "이 폴더 아래 문서가 생성·변경되면 변환합니다. 결과 폴더와 다른 경로를 사용하세요.", en: "Convert documents created or modified under this folder. Use a path different from the output folder." }), (setting) => { setting.addText((t) => t
      .setValue(this.plugin.settings.watchFolder).onChange(async (v) => { this.plugin.settings.watchFolder = normalizeVaultRelativeFolder(v) ?? ""; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "폴더 자동 변환", en: "Automatic folder conversion" }), undefined, (setting) => { setting.addToggle((t) => t.setValue(this.plugin.settings.watchEnabled)
      .onChange(async (v) => { this.plugin.settings.watchEnabled = v; await this.plugin.saveSettings(); })); });
    addRow(L({ ko: "변환 완료 웹훅", en: "Conversion completion webhook" }), L({ ko: "선택 사항. 설정한 HTTP(S) 주소에 파일명·결과 경로·성공 여부를 보냅니다.", en: "Optional. Send filename, output path and success status to the configured HTTP(S) address." }), (setting) => { setting.addText((t) => t
      .setValue(this.plugin.settings.webhookUrl).onChange(async (v) => { this.plugin.settings.webhookUrl = v.trim(); await this.plugin.saveSettings(); })); });

    rows.push({ kind: "footer", name: "KorDoc information and license", render: (container) => this.renderFooter(container) });
    return rows;
  }

  private renderFooter(containerEl: HTMLElement): void {
    const info = containerEl.createDiv({ cls: "kordoc-info" });
    info.createEl("p", {
      text:
        L({ ko: "지원 포맷: HWP, HWPX, HWPML, PDF, XLS, XLSX, DOCX, PPTX. HWPX 미리보기·문단/셀 편집과 로컬 텍스트·수식 OCR을 제공합니다. OCR은 위 설정에서 켤 수 있으며, 엔진과 모델은 문서 작업 시 불러옵니다. Windows x64 배포본은 인터넷 없이 동작합니다.", en: "Supported formats: HWP, HWPX, HWPML, PDF, XLS, XLSX, DOCX, PPTX. Provides HWPX preview, paragraph/cell editing, and local text/formula OCR. Enable OCR above; the engine and models load when working with documents. The Windows x64 distribution works without internet." }),
    });

    const license = containerEl.createDiv({ cls: "kordoc-license" });
    new Setting(license).setName(L({ ko: "오픈소스 라이선스", en: "Open-source licenses" })).setHeading();
    const attribution = license.createEl("p");
    attribution.appendText(L({ ko: "이 플러그인은 ", en: "This plugin includes " }));
    attribution.createEl("a", {
      text: "kordoc",
      href: "https://github.com/chrisryugj/kordoc",
    });
    attribution.appendText(
      L({ ko: ` ${VERSION}을 포함하며, Copyright (c) 2026 chrisryugj, MIT License로 제공됩니다.`, en: ` ${VERSION}, Copyright (c) 2026 chrisryugj, provided under the MIT License.` }),
    );
    license.createEl("p", {
      text:
        L({ ko: "라이선스 고지와 전문은 배포 폴더의 THIRD_PARTY_NOTICES.md에서도 확인할 수 있습니다.", en: "License notices and full text are also available in THIRD_PARTY_NOTICES.md in the distribution folder." }),
    });
    const licenseDetails = license.createEl("details");
    licenseDetails.createEl("summary", { text: L({ ko: "MIT License 전문 보기", en: "View full MIT License" }) });
    licenseDetails.createEl("pre", { text: KORDOC_LICENSE_TEXT });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(settingsHeading()).setHeading();
    for (const row of this.settingRows()) {
      if (row.kind === "footer") { row.render(containerEl); continue; }
      const setting = new Setting(containerEl).setName(row.name);
      if (row.desc !== undefined) setting.setDesc(row.desc);
      row.build(setting);
    }
  }

  getSettingDefinitions(): import("obsidian").SettingDefinitionItem[] {
    const rows = this.settingRows();
    const items: import("obsidian").SettingDefinitionRender[] = rows.filter((row): row is Extract<KordocSettingRow, { kind: "setting" }> => row.kind === "setting").map(row => ({
      name: row.name,
      ...(row.desc === undefined ? {} : { desc: row.desc }),
      render: (setting) => {
        setting.setName(row.name);
        if (row.desc !== undefined) setting.setDesc(row.desc);
        row.build(setting);
      },
    }));
    return [
      { type: "group", heading: settingsHeading(), items },
      ...rows.filter((row): row is Extract<KordocSettingRow, { kind: "footer" }> => row.kind === "footer").map(row => ({
        name: row.name, searchable: false, render: (setting: Setting) => {
          setting.setName(row.name);
          setting.settingEl.empty();
          row.render(setting.settingEl);
        },
      })),
    ];
  }
}
