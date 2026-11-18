export interface ExportNoticeFragmentHost {
  createSpan(o?: { text?: string }): HTMLElement;
  appendText(val: string): void;
  createEl(tag: "button", o?: { text?: string }): HTMLButtonElement;
}

export function buildExportNoticeFragment<T>(
  message: string,
  openLabel: string,
  onOpen: () => void,
  makeFragment: (callback: (frag: ExportNoticeFragmentHost) => void) => T,
): T {
  return makeFragment((frag) => {
    frag.createSpan({ text: message });
    frag.appendText(" ");
    const button = frag.createEl("button", { text: openLabel });
    button.addEventListener("click", () => {
      onOpen();
    });
  });
}
