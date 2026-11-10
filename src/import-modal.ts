import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import { resolveImportFolder } from "./import-target";

export interface ImportTarget {
  /** 볼트 기준 저장 폴더 ("" 이면 볼트 최상위) */
  folder: string;
  /** 원본 파일을 저장 폴더에 함께 복사 */
  copyOriginal: boolean;
}

/** 변환 전에 저장할 볼트 폴더(및 새 하위 폴더)와 원본 복사 여부를 묻는다. 취소하면 null. */
export function askImportTarget(app: App, fileNames: string[], initial: ImportTarget): Promise<ImportTarget | null> {
  return new Promise((resolve) => {
    class ImportTargetModal extends Modal {
      private submitted = false;
      private base = initial.folder;
      private sub = "";
      private copyOriginal = initial.copyOriginal;

      onOpen() {
        if (typeof this.setTitle === "function") this.setTitle("KorDoc: 가져올 위치 선택");
        else this.titleEl.setText("KorDoc: 가져올 위치 선택");
        const { contentEl } = this;
        contentEl.addClass("kordoc-import-target");
        const shown = fileNames.slice(0, 5).join(", ") + (fileNames.length > 5 ? ` 외 ${fileNames.length - 5}개` : "");
        contentEl.createEl("p", { text: `변환할 문서 ${fileNames.length}개: ${shown}`, cls: "kordoc-import-files" });

        const folders = app.vault.getAllLoadedFiles()
          .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
          .map((f) => f.path)
          .sort((a, b) => a.localeCompare(b, "ko"));
        const listId = `kordoc-folders-${Math.random().toString(36).slice(2)}`;

        new Setting(contentEl)
          .setName("저장할 폴더")
          .setDesc("볼트 안의 기존 폴더를 고르거나 경로를 입력하세요. 비우면 볼트 최상위입니다. 없는 경로는 새로 만듭니다.")
          .addText((t) => {
            t.setPlaceholder("(볼트 최상위)").setValue(this.base).onChange((v) => { this.base = v; this.updatePreview(); });
            const list = contentEl.createEl("datalist", { attr: { id: listId } });
            for (const path of folders) list.createEl("option", { value: path });
            t.inputEl.setAttribute("list", listId);
            t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
          });

        new Setting(contentEl)
          .setName("새 폴더 만들기 (선택)")
          .setDesc("위 폴더 아래에 새로 만들 폴더 이름입니다. 비우면 위 폴더에 바로 저장합니다.")
          .addText((t) => {
            t.setPlaceholder("새 폴더 이름").onChange((v) => { this.sub = v; this.updatePreview(); });
            t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
          });

        new Setting(contentEl)
          .setName("원본 파일도 함께 복사")
          .setDesc("변환 전 원본 문서를 마크다운 노트와 같은 폴더에 복사합니다.")
          .addToggle((t) => t.setValue(this.copyOriginal).onChange((v) => { this.copyOriginal = v; }));

        contentEl.createEl("p", { cls: "kordoc-import-preview" });
        this.updatePreview();

        new Setting(contentEl)
          .addButton((b) => b.setButtonText("변환").setCta().onClick(() => this.submit()))
          .addButton((b) => b.setButtonText("취소").onClick(() => this.close()));
      }

      private updatePreview() {
        const el = this.contentEl.querySelector(".kordoc-import-preview");
        if (!el) return;
        const folder = resolveImportFolder(this.base, this.sub);
        el.setText(folder === null
          ? "⚠ 폴더 경로가 올바르지 않습니다. 절대 경로, .., 금지 문자(\\ : * ? \" < > | # ^ [ ])는 쓸 수 없습니다."
          : `저장 위치: ${folder || "(볼트 최상위)"}`);
      }

      private submit() {
        const folder = resolveImportFolder(this.base, this.sub);
        if (folder === null) { new Notice("저장 폴더 경로가 올바르지 않습니다.", 5000); return; }
        this.submitted = true;
        resolve({ folder, copyOriginal: this.copyOriginal });
        this.close();
      }

      onClose() { this.contentEl.empty(); if (!this.submitted) resolve(null); }
    }
    new ImportTargetModal(app).open();
  });
}
