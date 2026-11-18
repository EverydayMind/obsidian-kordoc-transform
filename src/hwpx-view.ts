import { L } from "./locale";
import {
  App,
  FileView,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  detectZipFormat,
  renderHwpxToSvg,
  validateHwpx,
  type BlockEdit,
  type IRBlock,
  type RenderSvgResult,
} from "./engine";
import {
  assertSourceHash,
  HwpxEditSession,
  nextAvailableHwpxPath,
  parseEditCommand,
  sha256Hex,
  toArrayBuffer,
} from "./hwpx-edit";
import { resolveVerbexChatApi } from "./verbex-adapter";
import { guardZipInput } from "./zip-input-guard";
import type { ChatSubmissionResult, HwpEditScope, VerbexChatApi } from "./verbex-contract";

export const HWPX_VIEW_TYPE = "kordoc-hwpx-preview";

export interface HwpxViewOptions {
  /** 설정에서 명시적으로 원본 덮어쓰기를 허용했는지 */
  canOverwrite: () => boolean;
}

function previewText(block: IRBlock): string {
  if (block.type === "table" && block.table) {
    return L({ ko: `표 ${block.table.rows}행 × ${block.table.cols}열`, en: `Table: ${block.table.rows} rows × ${block.table.cols} columns` });
  }
  const text = (block.text ?? "").replace(/\s+/g, " ").trim();
  return text || L({ ko: "(내용 없음)", en: "(No content)" });
}

function blockTypeLabel(block: IRBlock): string {
  if (block.type === "heading") return L({ ko: `제목${block.level ? ` H${block.level}` : ""}`, en: `Heading${block.level ? ` H${block.level}` : ""}` });
  if (block.type === "paragraph") return L({ ko: "문단", en: "Paragraph" });
  if (block.type === "table") return L({ ko: "표", en: "Table" });
  return block.type;
}

function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return toArrayBuffer(bytes);
}

/** HWPX 전체 페이지 스크롤 뷰와 블록 단위 편집 패널. */
export class KordocHwpxView extends FileView {
  private readonly appRef: App;
  private readonly options: HwpxViewOptions;
  private session: HwpxEditSession | null = null;
  private renderResult: RenderSvgResult | null = null;
  private selectedBlockIndex: number | null = null;
  private blobUrl: string | null = null;
  private busy = false;
  private ownershipFile: TFile | null = null;
  private filenameEl: HTMLElement | null = null;

  /** The loading/loaded document belongs to this live view until unload/close. */
  getOwnershipPath(): string | null { return this.ownershipFile?.path ?? null; }

  async onClose(): Promise<void> {
    this.ownershipFile = null;
    await super.onClose();
  }

  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.ownershipFile = file;
    // Updating only the label preserves any unsubmitted prompt or cell input.
    this.filenameEl?.setText(file.name);
  }

  constructor(leaf: WorkspaceLeaf, app: App, options: HwpxViewOptions) {
    super(leaf);
    this.appRef = app;
    this.options = options;
    this.navigation = true;
    this.registerEvent(this.appRef.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.path !== this.file?.path || this.busy) return;
      void this.reloadAfterExternalModify(file);
    }));
  }

  getViewType(): string {
    return HWPX_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? L({ ko: `HWPX 미리보기: ${this.file.basename}`, en: `HWPX preview: ${this.file.basename}` }) : L({ ko: "HWPX 미리보기", en: "HWPX preview" });
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.ownershipFile = file;
    this.revokeBlobUrl();
    this.session = null;
    this.renderResult = null;
    this.selectedBlockIndex = null;
    this.contentEl.empty();
    this.showMessage(L({ ko: "HWPX를 여는 중…", en: "Opening HWPX…" }));

    try {
      const bytes = new Uint8Array(await this.appRef.vault.readBinary(file));
      await guardZipInput(bytes);
      const format = await detectZipFormat(makeArrayBuffer(bytes));
      if (format !== "hwpx") {
        throw new Error(
          L({ ko: "이 파일은 HWPX ZIP이 아닙니다. HWP 5.x 등 다른 형식은 마크다운 변환 명령을 사용하세요.", en: "This file is not an HWPX ZIP. For other formats such as HWP 5.x, use the Markdown conversion command." }),
        );
      }
      this.session = await HwpxEditSession.open(bytes);
      await this.renderCurrent();
      this.refreshUi();
    } catch (error) {
      this.session = null;
      this.renderResult = null;
      this.showError(error);
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.ownershipFile = null;
    this.revokeBlobUrl();
    this.session = null;
    this.renderResult = null;
    this.contentEl.empty();
  }

  /** Verbex commits through the vault; keep this preview in sync with that commit. */
  private async reloadAfterExternalModify(file: TFile): Promise<void> {
    const session = this.session;
    if (!session || session.isDirty) return;
    try {
      const bytes = new Uint8Array(await this.appRef.vault.readBinary(file));
      await guardZipInput(bytes);
      const format = await detectZipFormat(makeArrayBuffer(bytes));
      if (format !== "hwpx") return;
      await session.reload(bytes);
      await this.renderCurrent();
      this.refreshUi();
      new Notice(L({ ko: "✅ Verbex가 저장한 HWPX 변경을 미리보기에 반영했습니다.", en: "✅ HWPX changes saved by Verbex are reflected in the preview." }), 5000);
    } catch (error) {
      console.error("[KorDoc] failed to reload externally modified HWPX", error);
    }
  }

  /** 명령 팔레트에서 호출하는 공개 진입점. */
  openCommandPalette(): void {
    new HwpxPromptModal(this.appRef, (prompt) => {
      void this.executePrompt(prompt);
    }).open();
  }

  private async renderCurrent(): Promise<void> {
    if (!this.session) throw new Error(L({ ko: "HWPX 세션이 열려 있지 않습니다.", en: "No HWPX session is open." }));
    const bytes = this.session.bytes;
    this.renderResult = await renderHwpxToSvg(bytes, {
      // 생성본·편집본은 linesegarray가 없으므로 항상 reflow를 켠다.
      reflow: true,
    });
  }

  private refreshUi(): void {
    this.revokeBlobUrl();
    this.contentEl.empty();
    if (!this.session || !this.renderResult) {
      this.showMessage(L({ ko: "표시할 HWPX가 없습니다.", en: "There is no HWPX to display." }));
      return;
    }

    const root = this.contentEl.createDiv({ cls: "kordoc-hwpx-view" });
    this.renderToolbar(root);

    const layout = root.createDiv({ cls: "kordoc-hwpx-layout" });
    const preview = layout.createDiv({ cls: "kordoc-hwpx-preview" });
    this.renderPreview(preview);

    const inspector = layout.createDiv({ cls: "kordoc-hwpx-inspector" });
    this.renderInspector(inspector);
  }

  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "kordoc-hwpx-toolbar" });
    const title = toolbar.createDiv({ cls: "kordoc-hwpx-toolbar-title" });
    this.filenameEl = title.createEl("strong", { text: this.file?.name ?? "HWPX" });
    const result = this.renderResult;
    const badge = title.createSpan({
      cls: "kordoc-hwpx-badge kordoc-hwpx-badge-approx",
      text: L({ ko: "근사 미리보기", en: "Approximate preview" }),
    });
    badge.setAttribute(
      "title",
      L({
        ko: "글자 배치는 한컴오피스와 조금 다를 수 있습니다.",
        en: "Text layout may differ slightly from Hancom Office.",
      }),
    );

    if (result) {
      toolbar.createSpan({
        cls: "kordoc-hwpx-stats",
        text: L({ ko: `${result.pageCount}쪽 · 텍스트 ${result.stats.texts} · 표 ${result.stats.tables}`, en: `${result.pageCount} pages · Text ${result.stats.texts} · Tables ${result.stats.tables}` }),
      });
    }

    const actions = toolbar.createDiv({ cls: "kordoc-hwpx-toolbar-actions" });
    const saveAs = actions.createEl("button", { text: L({ ko: "저장 (다른 이름)", en: "Save as" }) });
    saveAs.addEventListener("click", () => void this.save("save-as"));
    if (this.options.canOverwrite()) {
      const overwrite = actions.createEl("button", { text: L({ ko: "원본 덮어쓰기", en: "Overwrite source" }) });
      overwrite.addClass("mod-warning");
      overwrite.addEventListener("click", () => void this.save("overwrite"));
    }

    const prompt = root.createDiv({ cls: "kordoc-hwpx-command" });
    const promptInput = prompt.createEl("input", {
      type: "text",
      placeholder: L({ ko: "예: 3번째 문단을 새 내용으로 바꿔줘", en: "Edit commands are understood in Korean only, for example: 3번째 문단을 새 내용으로 바꿔줘" }),
    });
    const promptButton = prompt.createEl("button", { text: L({ ko: "편집 명령 실행", en: "Run edit command" }) });
    const run = () => {
      const value = promptInput.value;
      promptInput.value = "";
      void this.executePrompt(value);
    };
    promptButton.addEventListener("click", run);
    promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") run();
    });
  }

  private renderPreview(container: HTMLElement): void {
    const result = this.renderResult;
    if (!result) return;
    const scroll = container.createDiv({ cls: "kordoc-hwpx-svg-scroll" });
    const image = scroll.createEl("img", { cls: "kordoc-hwpx-svg-image", attr: { alt: L({ ko: `${this.file?.name ?? "HWPX"} 미리보기`, en: `${this.file?.name ?? "HWPX"} preview` }) } });
    image.width = Math.max(1, Math.round(result.width));
    image.style.width = `${result.width}pt`;
    this.blobUrl = URL.createObjectURL(
      new Blob([result.svg], { type: "image/svg+xml" }),
    );
    image.src = this.blobUrl;

    if (result.warnings.length > 0) {
      const details = container.createEl("details", { cls: "kordoc-hwpx-warnings" });
      details.createEl("summary", { text: L({ ko: `렌더링 경고 ${result.warnings.length}건`, en: `${result.warnings.length} rendering warnings` }) });
      const list = details.createEl("ul");
      for (const warning of result.warnings) list.createEl("li", { text: warning });
    }
  }

  private renderInspector(container: HTMLElement): void {
    container.createEl("h3", { text: L({ ko: "블록 편집", en: "Edit blocks" }) });
    container.createEl("p", {
      cls: "kordoc-hwpx-help",
      text: L({ ko: "문단·제목 또는 표 셀 텍스트만 편집할 수 있습니다. 자동 저장되지 않습니다.", en: "Only paragraph/heading or table-cell text can be edited. Changes are not saved automatically." }),
    });

    if (this.selectedBlockIndex !== null) {
      const lock = container.createDiv({ cls: "kordoc-hwpx-selection-lock" });
      lock.createSpan({
        text: L({ ko: `현재 ${this.selectedBlockIndex + 1}번 블록을 Verbex 편집 대상으로 고정했습니다.`, en: `Block ${this.selectedBlockIndex + 1} is currently pinned as the Verbex edit target.` }),
      });
      const clear = lock.createEl("button", { text: L({ ko: "선택 해제하고 문서에서 찾기", en: "Clear selection and find in document" }) });
      clear.addEventListener("click", () => {
        this.selectedBlockIndex = null;
        this.refreshUi();
      });
      this.renderEditor(container, this.selectedBlockIndex);
    }

    const list = container.createDiv({ cls: "kordoc-hwpx-block-list" });
    this.session?.blocks.forEach((block, index) => {
      const capability = this.session?.capability(index);
      const item = list.createDiv({
        cls: index === this.selectedBlockIndex
          ? "kordoc-hwpx-block is-selected"
          : "kordoc-hwpx-block",
      });
      const button = item.createEl("button", { cls: "kordoc-hwpx-block-button" });
      button.createSpan({ cls: "kordoc-hwpx-block-index", text: `${index + 1}` });
      const copy = button.createDiv({ cls: "kordoc-hwpx-block-copy" });
      copy.createSpan({ cls: "kordoc-hwpx-block-type", text: blockTypeLabel(block) });
      copy.createSpan({ cls: "kordoc-hwpx-block-text", text: previewText(block) });
      if (capability?.capability === "locked") {
        item.createSpan({ cls: "kordoc-hwpx-lock", text: L({ ko: "잠금", en: "Locked" }) });
        button.title = capability.reason ?? L({ ko: "편집할 수 없는 블록", en: "Block cannot be edited" });
      }
      button.addEventListener("click", () => {
        this.selectedBlockIndex = index;
        this.refreshUi();
      });
    });
  }

  private renderEditor(container: HTMLElement, blockIndex: number): void {
    const block = this.session?.blocks[blockIndex];
    const session = this.session;
    if (!block || !session) return;
    const editor = container.createDiv({ cls: "kordoc-hwpx-editor" });
    editor.createEl("h4", { text: L({ ko: `${blockIndex + 1}번 블록 편집`, en: `Edit block ${blockIndex + 1}` }) });
    const capability = session.capability(blockIndex);
    if (capability.capability === "locked") {
      editor.createEl("p", {
        cls: "kordoc-hwpx-locked-message",
        text: capability.reason ?? L({ ko: "이 블록은 편집할 수 없습니다.", en: "This block cannot be edited." }),
      });
      return;
    }

    if (block.type === "paragraph" || block.type === "heading") {
      const textarea = editor.createEl("textarea", { cls: "kordoc-hwpx-text-editor" });
      textarea.value = block.text ?? "";
      const apply = editor.createEl("button", { text: L({ ko: "문단에 적용", en: "Apply to paragraph" }) });
      apply.addEventListener("click", () => {
        void this.applyEdits([{ blockIndex, newText: textarea.value }]);
      });
      return;
    }

    if (block.type !== "table" || !block.table) return;
    editor.createEl("p", {
      cls: "kordoc-hwpx-help",
      text: L({ ko: "이미지 토큰이 있는 셀은 토큰을 지우지 말고 텍스트만 바꾸세요. 행·열 추가/삭제는 지원하지 않습니다.", en: "For cells with image tokens, change only the text and preserve the tokens. Adding/deleting rows or columns is not supported." }),
    });
    const table = editor.createEl("table", { cls: "kordoc-hwpx-cell-editor" });
    const fields: Array<{ row: number; col: number; initial: string; input: HTMLTextAreaElement }> = [];
    for (let row = 0; row < block.table.rows; row++) {
      const tr = table.createEl("tr");
      for (let col = 0; col < block.table.cols; col++) {
        const td = tr.createEl("td");
        const cell = block.table.cells[row]?.[col];
        const input = td.createEl("textarea");
        input.value = cell?.text ?? "";
        const cellCapability = capability.cells?.[row]?.[col];
        if (!cell || !cellCapability?.editable) {
          input.disabled = true;
          input.title = cellCapability?.reason ?? L({ ko: "편집할 수 없는 셀", en: "Cell cannot be edited" });
        } else {
          fields.push({ row, col, initial: input.value, input });
        }
      }
    }
    const apply = editor.createEl("button", { text: L({ ko: "셀 변경 적용", en: "Apply cell changes" }) });
    apply.addEventListener("click", () => {
      const cells = fields
        .filter((field) => field.input.value !== field.initial)
        .map((field) => ({ row: field.row, col: field.col, text: field.input.value }));
      if (cells.length === 0) {
        new Notice(L({ ko: "변경된 셀이 없습니다.", en: "No cells have changed." }));
        return;
      }
      void this.applyEdits([{ blockIndex, cells }]);
    });
  }

  private async executePrompt(prompt: string): Promise<void> {
    const session = this.session;
    if (!session) {
      new Notice(L({ ko: "먼저 HWPX 파일을 여세요.", en: "Open an HWPX file first." }));
      return;
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      new Notice(L({ ko: "편집 요청을 입력하세요.", en: "Enter an edit request." }));
      return;
    }

    let verbexChat: VerbexChatApi | null;
    try {
      verbexChat = resolveVerbexChatApi(this.appRef);
    } catch (error) {
      console.error("[KorDoc] Verbex chat bridge is incompatible", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(L({ ko: `Verbex 연결 실패: ${message}`, en: `Verbex connection failed: ${message}` }), 8000);
      return;
    }

    if (verbexChat) {
      const file = this.file;
      if (!file) {
        new Notice(L({ ko: "HWPX 대상 파일을 확인할 수 없습니다.", en: "Cannot determine the target HWPX file." }));
        return;
      }
      if (session.isDirty) {
        new Notice(
          L({ ko: "미저장 KORDOC 편집이 있습니다. 먼저 저장한 뒤 Verbex 편집 요청을 보내세요.", en: "There are unsaved KORDOC edits. Save them before sending a Verbex edit request." }),
          8000,
        );
        return;
      }

      const request = [
        L({ ko: "KORDOC HWPX 미리보기에서 전달된 편집 요청입니다.", en: "Edit request forwarded from the KORDOC HWPX preview." }),
        L({ ko: `대상 HWPX 파일(볼트 상대경로): ${file.path}`, en: `Target HWPX file (vault-relative path): ${file.path}` }),
        "",
        L({ ko: "사용자 편집 요청:", en: "User edit request:" }),
        normalizedPrompt,
        "",
        L({ ko: "작업 규칙:", en: "Task rules:" }),
        L({ ko: "- 대상 파일은 위 경로의 HWPX로 고정합니다.", en: "- The target file is fixed to the HWPX at the path above." }),
        L({ ko: "- 먼저 KORDOC provider 도구로 문서와 블록을 확인합니다.", en: "- First inspect the document and blocks with KORDOC provider tools." }),
        L({ ko: "- 수정안은 provider의 패치 준비 절차를 사용하고, Verbex의 승인 후에만 저장합니다.", en: "- Prepare the proposed edits through the provider's patch preparation process; save only after Verbex approval." }),
      ].join("\n");

      const selectedBlock = this.selectedBlockIndex === null
        ? undefined
        : session.blocks[this.selectedBlockIndex];
      const selectedCapability = this.selectedBlockIndex === null
        ? undefined
        : session.capability(this.selectedBlockIndex);
      const editableTableCells = selectedBlock?.table && selectedCapability?.cells
        ? selectedCapability.cells.flatMap((row, rowIndex) =>
            row
              .map((cell, colIndex) => ({
                row: rowIndex,
                col: colIndex,
                text: selectedBlock.table?.cells[rowIndex]?.[colIndex]?.text ?? "",
                editable: cell.editable,
              }))
              .filter((cell) => cell.editable),
          )
        : [];
      const scope: HwpEditScope = {
        // Always bind the turn to this document. Selection adds an explicit
        // block lock; clearing selection lets the model locate a block via
        // kordoc__inspect_blocks while the host still verifies path/hash.
        scope: selectedBlock ? "single-block" : "document",
        operation: "transform",
        contextId: window.crypto.randomUUID(),
        path: file.path,
        sourceHash: session.sourceHash,
        ...(selectedBlock && this.selectedBlockIndex !== null
          ? {
              blockIndex: this.selectedBlockIndex,
              blockType: selectedBlock.type === "table" || selectedBlock.type === "heading"
                ? selectedBlock.type
                : "paragraph",
            }
          : {}),
        ...(selectedBlock?.table
          ? {
              tableShape: {
                rows: selectedBlock.table.rows,
                cols: selectedBlock.table.cols,
              },
              ...(selectedBlock.table.rows === 1 && selectedBlock.table.cols === 1
                ? { targetCell: { row: 0, col: 0 } }
                : {}),
              tableCells: editableTableCells
                .slice(0, 512)
                .map(({ row, col, text }) => ({
                  row,
                  col,
                  // Scope previews are model context, not an unbounded data
                  // channel. The provider remains authoritative at apply time.
                  text: text.slice(0, 240),
                })),
              ...(editableTableCells.length > 512
                ? { tableCellsTruncated: true }
                : {}),
            }
          : {}),
      };

      try {
        const result: ChatSubmissionResult = verbexChat.sendMessageV2
          ? await verbexChat.sendMessageV2(request, scope ? { scope } : undefined)
          : (await verbexChat.sendMessage(request)
            ? { status: "submitted", messageId: "legacy" }
            : { status: "rejected", reason: "legacy chat bridge returned false" });
        if (result.status === "submitted") {
          new Notice(
            L({ ko: "Verbex에 편집 요청을 전달했습니다. Verbex 채팅에서 검사·승인 진행을 확인하세요.", en: "The edit request was sent to Verbex. Follow validation and approval in the Verbex chat." }),
            6000,
          );
        } else if (result.status === "selection_required") {
          new Notice(
            L({ ko: "Verbex에서 추천 Skill/workflow를 확인한 뒤 Proceed를 누르세요.", en: "Review the recommended Skill/workflow in Verbex, then press Proceed." }),
            8000,
          );
        } else if (result.status === "busy") {
          new Notice(L({ ko: `Verbex가 다른 요청을 처리 중입니다.${result.reason ? ` ${result.reason}` : ""}`, en: `Verbex is processing another request.${result.reason ? ` ${result.reason}` : ""}` }), 8000);
        } else {
          new Notice(
            L({ ko: `Verbex 편집 요청을 제출하지 못했습니다.${result.reason ? ` ${result.reason}` : ""}`, en: `Could not submit the Verbex edit request.${result.reason ? ` ${result.reason}` : ""}` }),
            8000,
          );
        }
      } catch (error) {
        console.error("[KorDoc] failed to send HWPX edit request to Verbex", error);
        const message = error instanceof Error ? error.message : String(error);
        new Notice(L({ ko: `Verbex 편집 요청 전달 실패: ${message}`, en: `Failed to forward the Verbex edit request: ${message}` }), 8000);
      }
      return;
    }

    // Verbex가 설치되어 있지 않은 독립 실행 환경에서는 기존 명령 parser를 유지한다.
    await this.executeLocalPrompt(normalizedPrompt, session);
  }

  private async executeLocalPrompt(
    prompt: string,
    session: HwpxEditSession,
  ): Promise<void> {
    const parsed = parseEditCommand(prompt, session.blocks);
    if (!parsed.edits?.length) {
      new Notice(parsed.message ?? L({ ko: "편집 명령을 해석하지 못했습니다.", en: "Could not interpret the edit command." }), 7000);
      return;
    }
    this.selectedBlockIndex = parsed.edits[0].blockIndex;
    await this.applyEdits(parsed.edits);
  }

  private async applyEdits(edits: BlockEdit[]): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    try {
      const expectedRevision = this.session.sessionRevision;
      const applied = await this.session.patch(edits, expectedRevision);
      await this.renderCurrent();
      this.refreshUi();
      const changed = applied.result.changes?.diffs.length ?? applied.result.applied;
      new Notice(L({ ko: `✅ ${changed}건 편집 적용됨. 저장 버튼을 눌러 파일에 반영하세요.`, en: `✅ Applied ${changed} edits. Press Save to write them to the file.` }), 5000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(L({ ko: `편집 실패: ${message}`, en: `Edit failed: ${message}` }), 8000);
      this.refreshUi();
    } finally {
      this.busy = false;
    }
  }

  private async save(mode: "save-as" | "overwrite"): Promise<void> {
    const session = this.session;
    const file = this.file;
    if (!session || !file || this.busy) return;
    if (mode === "overwrite" && !this.options.canOverwrite()) {
      new Notice(L({ ko: "원본 덮어쓰기는 설정에서 명시적으로 허용해야 합니다.", en: "Overwriting the source must be explicitly enabled in settings." }), 6000);
      return;
    }
    this.busy = true;
    try {
      const currentSource = new Uint8Array(await this.appRef.vault.readBinary(file));
      const currentHash = await sha256Hex(currentSource);
      assertSourceHash(session.sourceHash, currentHash);

      const bytes = session.bytes;
      const validation = await validateHwpx(bytes);
      if (!validation.ok) {
        throw new Error(
          L({ ko: `저장 전 HWPX 검증 실패:\n${validation.issues.map((i) => i.message).join("\n")}`, en: `HWPX validation failed before saving:
${validation.issues.map((i) => i.message).join("\n")}` }),
        );
      }
      const buffer = makeArrayBuffer(bytes);

      if (mode === "overwrite") {
        await this.appRef.vault.modifyBinary(file, buffer);
        await session.markSaved(bytes);
        await this.renderCurrent();
        this.refreshUi();
        new Notice(L({ ko: `✅ 원본에 저장했습니다: ${file.path}`, en: `✅ Saved to source: ${file.path}` }), 6000);
        return;
      }

      const outputPath = await nextAvailableHwpxPath(
        file.path,
        (path) => this.appRef.vault.adapter.exists(path),
      );
      let created: TFile | null = null;
      let candidate = outputPath;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        try {
          created = await this.appRef.vault.createBinary(candidate, buffer);
        } catch (error) {
          if (!(await this.appRef.vault.adapter.exists(candidate))) throw error;
          candidate = await nextAvailableHwpxPath(
            file.path,
            (path) => this.appRef.vault.adapter.exists(path),
          );
        }
      }
      if (!created) throw new Error(L({ ko: "편집본을 저장할 빈 경로를 찾지 못했습니다.", en: "Could not find an unused path for the edited copy." }));
      new Notice(L({ ko: `✅ 편집본 저장 완료: ${created.path}`, en: `✅ Edited copy saved: ${created.path}` }), 6000);
      await this.leaf.openFile(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(L({ ko: `저장 실패: ${message}`, en: `Save failed: ${message}` }), 8000);
    } finally {
      this.busy = false;
    }
  }

  private showMessage(message: string): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "kordoc-hwpx-message", text: message });
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: "kordoc-hwpx-error" });
    box.createEl("h3", { text: L({ ko: "HWPX 미리보기를 열 수 없습니다", en: "Cannot open HWPX preview" }) });
    box.createEl("p", { text: message });
    box.createEl("p", {
      text: L({ ko: "HWP/HWPML/PDF/DOCX/PPTX/XLS/XLSX는 ‘마크다운으로 변환’ 명령을 사용하세요.", en: "For HWP/HWPML/PDF/DOCX/PPTX/XLS/XLSX, use the 'Convert to Markdown' command." }),
    });
  }

  private revokeBlobUrl(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}

class HwpxPromptModal extends Modal {
  private readonly onSubmit: (prompt: string) => void;

  constructor(app: App, onSubmit: (prompt: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    if (typeof this.setTitle === "function") this.setTitle(L({ ko: "KorDoc: 편집 명령 실행", en: "KorDoc: Run edit command" }));
    else this.titleEl.setText(L({ ko: "KorDoc: 편집 명령 실행", en: "KorDoc: Run edit command" }));
    const input = this.contentEl.createEl("input", {
      type: "text",
      placeholder: L({ ko: "3번째 문단을 새 내용으로 바꿔줘", en: "Edit commands are understood in Korean only, for example: 3번째 문단을 새 내용으로 바꿔줘" }),
    });
    input.addClass("kordoc-hwpx-command-input");
    this.contentEl.createEl("p", {
      cls: "kordoc-hwpx-help",
      text: L({ ko: "지원 패턴: n번째 문단을 X로 바꿔줘 · 표 R행 C열 값을 X로 바꿔줘", en: "Edit commands are understood in Korean only. Supported patterns: n번째 문단을 X로 바꿔줘 · 표 R행 C열 값을 X로 바꿔줘" }),
    });
    const button = this.contentEl.createEl("button", { text: L({ ko: "실행", en: "Run" }) });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
