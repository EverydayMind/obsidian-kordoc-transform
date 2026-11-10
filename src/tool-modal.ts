import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { ParseOptions, RedactRule, MarkdownToHwpxOptions } from "./engine";
import { TOOL_ACTIONS, parseValues, runDocumentTool, jsonStringify, type ToolAction, type ToolRequest, type ToolResult } from "./document-tools";
import { EMBEDDED_TEMPLATES } from "./template-data";

export interface ToolModalHost {
  app: App;
  parseOptions(): ParseOptions;
  prepareGeneration(source: string, sourcePath?: string): Promise<{ markdown: string; options: MarkdownToHwpxOptions }>;
  saveToolResult(name: string, action: ToolAction, result: ToolResult): Promise<unknown>;
}
const DOCUMENT_EXTENSIONS = "hwp,hwpx,hwpml,hml,pdf,xls,xlsx,docx,pptx,md";

export function askPassword(app: App): Promise<string | null> {
  return new Promise((resolve) => {
    class PasswordModal extends Modal {
      private submitted = false;
      onOpen() {
        if (typeof this.setTitle === "function") this.setTitle("문서 열기 암호");
        else this.titleEl.setText("문서 열기 암호");
        const input = this.contentEl.createEl("input", { type: "password" });
        input.setAttribute("autocomplete", "off");
        this.contentEl.createEl("p", { text: "암호는 이번 작업에만 사용합니다." });
        const submit = () => { this.submitted = true; resolve(input.value); input.value = ""; this.close(); };
        const button = this.contentEl.createEl("button", { text: "열기" });
        button.addEventListener("click", submit);
        input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
        input.focus();
      }
      onClose() { this.contentEl.empty(); if (!this.submitted) resolve(null); }
    }
    new PasswordModal(app).open();
  });
}

/** One dialog exposes each engine operation with its required inputs and a result list. */
export class DocumentToolsModal extends Modal {
  private action: ToolAction;
  private path: string;
  private external?: { name: string; buffer: ArrayBuffer };
  private busy = false;
  constructor(private readonly host: ToolModalHost, action: ToolAction = "json", file?: TFile) {
    super(host.app); this.action = action; this.path = file?.path ?? host.app.workspace.getActiveFile()?.path ?? "";
  }

  onOpen(): void { this.draw(); }
  onClose(): void { this.contentEl.empty(); this.external = undefined; }

  private pathInput(container: HTMLElement, label: string, initial: string, extensions: string, onChange: (path: string) => void): HTMLInputElement {
    const input = container.createEl("input", { type: "text", value: initial });
    input.setAttribute("aria-label", label); input.placeholder = label;
    const id = `kordoc-files-${Math.random().toString(36).slice(2)}`;
    const list = container.createEl("datalist", { attr: { id } });
    const allowed = extensions.split(",");
    for (const file of this.app.vault.getFiles()) if (allowed.includes(file.extension.toLowerCase())) list.createEl("option", { value: file.path });
    input.setAttribute("list", id);
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }

  private async readPath(path: string): Promise<{ name: string; buffer: ArrayBuffer; markdown?: string }> {
    const file = this.app.vault.getAbstractFileByPath(path.trim());
    if (!(file instanceof TFile)) throw new Error(`볼트에서 파일을 찾지 못했습니다: ${path}`);
    let markdown: string | undefined;
    if (file.extension === "md") {
      const active = this.app.workspace.activeEditor;
      markdown = active?.file?.path === file.path && active.editor ? active.editor.getValue() : await this.app.vault.read(file);
    }
    return { name: file.name, buffer: await this.app.vault.readBinary(file), markdown };
  }

  private draw(): void {
    this.contentEl.empty();
    if (typeof this.setTitle === "function") this.setTitle("KorDoc 문서 도구");
    else this.titleEl.setText("KorDoc 문서 도구");
    this.contentEl.addClass("kordoc-tools");
    new Setting(this.contentEl).setName("작업").addDropdown((d) => {
      for (const [action, title] of Object.entries(TOOL_ACTIONS)) d.addOption(action, title);
      d.setValue(this.action).onChange((v) => { this.action = v as ToolAction; this.draw(); });
    });
    if (this.action !== "template") {
      const field = new Setting(this.contentEl).setName("대상 문서");
      const pathInput = this.pathInput(field.controlEl, "볼트 파일 경로", this.external?.name ?? this.path, DOCUMENT_EXTENSIONS, (v) => { this.path = v; this.external = undefined; });
      field.addButton((b) => b.setButtonText("외부 파일 선택").onClick(() => {
        const picker = document.createElement("input"); picker.type = "file";
        picker.accept = DOCUMENT_EXTENSIONS.split(",").map((x) => `.${x}`).join(",");
        picker.addEventListener("change", () => { void (async () => {
          const file = picker.files?.[0];
          if (file) { this.external = { name: file.name, buffer: await file.arrayBuffer() }; pathInput.value = file.name; }
        })(); }); picker.click();
      }));
    }
    let secondPath = "";
    if (this.action === "compare" || this.action === "patch") {
      const field = new Setting(this.contentEl).setName(this.action === "compare" ? "새 문서" : "반영할 Markdown");
      this.pathInput(field.controlEl, "볼트 파일 경로", "", this.action === "patch" ? "md" : DOCUMENT_EXTENSIONS, (v) => secondPath = v);
    }
    let templateId = "gian";
    const values = this.contentEl.createDiv();
    let valuesInput: HTMLTextAreaElement | undefined;
    if (this.action === "fill" || this.action === "template") {
      if (this.action === "template") new Setting(this.contentEl).setName("표준 서식").addDropdown((d) => {
        for (const t of EMBEDDED_TEMPLATES) d.addOption(t.id, t.title);
        d.setValue(templateId).onChange((v) => { templateId = v; valuesInput!.value = jsonStringify(EMBEDDED_TEMPLATES.find((t) => t.id === v)!.sample); });
      });
      values.createEl("p", { text: "필드별 값 (JSON) — 반복 값은 배열, 값 서식은 {value, format}으로 지정할 수 있습니다." });
      valuesInput = values.createEl("textarea", { cls: "kordoc-tool-values" });
      valuesInput.value = this.action === "template" ? jsonStringify(EMBEDDED_TEMPLATES[0].sample) : "{}";
      if (this.action === "fill") new Setting(values).addButton((b) => b.setButtonText("필드 불러오기").onClick(async () => {
        try {
          const source = this.external ?? await this.readPath(this.path);
          const form = await runDocumentTool({ action: "form", ...source, options: this.host.parseOptions() });
          const report = form.report;
          if (!report || typeof report !== "object" || !("result" in report)) throw new Error("Invalid form report");
          const details = report.result;
          if (!details || typeof details !== "object" || !("fields" in details) || !("clickHere" in details) || !Array.isArray(details.fields) || !Array.isArray(details.clickHere)) throw new Error("Invalid form report");
          const entries = (items: unknown[], key: string): [string, unknown][] => items.map((item) => {
            if (!item || typeof item !== "object" || !(key in item) || !("value" in item)) throw new Error("Invalid form field");
            return [String((item as Record<string, unknown>)[key]), item.value];
          });
          valuesInput!.value = jsonStringify(Object.fromEntries([...entries(details.fields, "label"), ...entries(details.clickHere, "name")]));
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      }));
    }
    let requireUnique = true;
    if (valuesInput) new Setting(this.contentEl).setName("모호한 라벨 중복 입력 거부").addToggle((t) => t.setValue(true).onChange((v) => requireUnique = v));
    let imagePath = "", anchor = "(인)", sealMode: "auto" | "right" | "overlap" = "auto", occurrence = 0, sizeMm = 12;
    if (this.action === "seal") {
      const image = new Setting(this.contentEl).setName("도장·서명 이미지");
      this.pathInput(image.controlEl, "볼트 이미지 경로", "", "png,jpg,jpeg,gif,bmp", (v) => imagePath = v);
      new Setting(this.contentEl).setName("기준 문구").addText((t) => t.setValue(anchor).onChange((v) => anchor = v));
      new Setting(this.contentEl).setName("같은 문구의 순번 (1부터)").addText((t) => t.setValue("1").onChange((v) => occurrence = Number(v) - 1));
      new Setting(this.contentEl).setName("크기 (mm)").addText((t) => t.setValue("12").onChange((v) => sizeMm = Number(v)));
      new Setting(this.contentEl).setName("배치").addDropdown((d) => d.addOptions({ auto: "자동", right: "문구 오른쪽", overlap: "문구 위" }).onChange((v) => sealMode = v as typeof sealMode));
    }
    let pages = String(this.host.parseOptions().pages ?? ""), password = "", highlights = "", reflowMode: "keep" | "charAll" = "keep", tableIndex = "";
    if (!["template", "seal", "validate", "profile", "patch"].includes(this.action)) new Setting(this.contentEl).setName("쪽 범위 (비우면 전체)").addText((t) => t.setValue(pages).setPlaceholder("1-3,5").onChange((v) => pages = v));
    if (["preview", "svg", "html", "regions"].includes(this.action)) {
      new Setting(this.contentEl).setName("강조할 검색어").addText((t) => t.setPlaceholder("예산,일정").onChange((v) => highlights = v));
      new Setting(this.contentEl).setName("근사 조판 줄바꿈").addDropdown((d) => d.addOptions({ keep: "어절 단위", charAll: "글자 단위" }).onChange((v) => reflowMode = v as typeof reflowMode));
    }
    if (this.action === "tables") new Setting(this.contentEl).setName("표 순번 (비우면 모든 표)").addText((t) => t.setPlaceholder("1").onChange((v) => tableIndex = v));
    if (this.action !== "template") new Setting(this.contentEl).setName("열기 암호 (필요한 경우)").addText((t) => { t.inputEl.type = "password"; t.inputEl.autocomplete = "off"; t.onChange((v) => password = v); });
    let rules: RedactRule[] | undefined, maskChar = "●";
    if (this.action === "redact") {
      new Setting(this.contentEl).setName("검출 항목 (비우면 기본값)").setDesc("rrn,phone,email,card,account,brn,passport,driver / 선택: crn,ip,name,address").addText((t) => t.onChange((v) => rules = v.trim() ? v.split(",").map((s) => s.trim()) as RedactRule[] : undefined));
      new Setting(this.contentEl).setName("마스킹 문자").addText((t) => t.setValue(maskChar).onChange((v) => maskChar = v));
      this.contentEl.createEl("p", { text: "텍스트 영역을 마스킹합니다. 결과는 공개 전에 확인하세요. 이미지 속 글자는 인식하지 않습니다." });
    }
    const status = this.contentEl.createDiv({ cls: "kordoc-tool-status", attr: { role: "status" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("실행하고 결과 저장").setCta().onClick(async () => {
      if (this.busy) return;
      this.busy = true; button.setDisabled(true); status.setText("처리 중…");
      try {
        const source = this.action === "template" ? { name: templateId } : this.external ?? await this.readPath(this.path);
        const request: ToolRequest = { action: this.action, ...source,
          options: { ...this.host.parseOptions(), pages, password }, template: templateId, requireUnique,
          highlights: highlights.split(",").map((s) => s.trim()).filter(Boolean), reflowMode,
          redactOptions: { rules, maskChar }, tableIndex: tableIndex.trim() ? Number(tableIndex) : undefined,
        };
        if ("buffer" in source && source.name.toLowerCase().endsWith(".md")) request.markdown = "markdown" in source ? String(source.markdown) : new TextDecoder().decode(source.buffer);
        if (secondPath) {
          const second = await this.readPath(secondPath);
          if (this.action === "patch") request.markdown = second.markdown; else request.second = second.buffer;
        }
        if (valuesInput) request.values = parseValues(valuesInput.value);
        if (this.action === "generate" && request.markdown !== undefined) {
          const prepared = await this.host.prepareGeneration(request.markdown, this.external ? undefined : this.path);
          request.markdown = prepared.markdown; request.generateOptions = prepared.options;
        }
        if (this.action === "seal") {
          if (!Number.isInteger(occurrence) || occurrence < 0 || !Number.isFinite(sizeMm) || sizeMm <= 0) throw new Error("순번과 크기를 올바르게 입력하세요.");
          const image = await this.readPath(imagePath);
          request.image = new Uint8Array(image.buffer); request.imageExt = image.name.split(".").pop()!.toLowerCase() as ToolRequest["imageExt"];
          request.anchor = anchor; request.sealOptions = { occurrence, sizeMm, mode: sealMode };
        }
        const result = await runDocumentTool(request);
        await this.host.saveToolResult(source.name, this.action, result);
        status.setText(`완료: 결과 ${result.artifacts.length}개와 보고서를 저장했습니다.`);
        password = "";
      } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
      finally { this.busy = false; button.setDisabled(false); }
    }));
  }
}
