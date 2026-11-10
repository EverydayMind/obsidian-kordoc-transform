declare module "*redact-doc-HQNN2ECF.js" {
  import type { RedactHit, RedactOptions, RedactRule } from "kordoc";

  interface FileHit {
    rule: RedactRule;
    masked: string;
    part: string;
    where: string;
  }

  export function redactDocument(
    input: ArrayBuffer | Uint8Array,
    options?: RedactOptions & { filePath?: string; dryRun?: boolean },
  ): Promise<{
    format: string;
    markdown: string;
    markdownHits: RedactHit[];
    data?: Uint8Array;
    changed: boolean;
    fileHits: FileHit[];
    residual: FileHit[];
    unscanned: string[];
    warnings: string[];
  }>;
}
