/** MD→HWPX 내보내기에서 kordoc에 넘기기 전 적용하는 순수 변환 헬퍼. */

export const GONGMUN_PRESETS = [
  "official",
  "report",
  "plan",
  "notice",
  "minutes",
  "gaejosik",
  "press",
  "ministry",
  "bangchim",
] as const;

export type GongmunPresetKey = (typeof GONGMUN_PRESETS)[number];
export type GongmunPresetSetting = "none" | GongmunPresetKey;

const IMAGE_EXTENSIONS = /^(png|jpg|jpeg|gif|bmp|tif|tiff)$/i;
const SIMPLE_IMAGE_FILENAME = /^[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/;

/** kordoc ImageRegistry가 1×1 placeholder를 만들 수 있는 파일명인지 판정한다. */
export function isPlaceholderImageFilename(value: string): boolean {
  const name = value.trim();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  return SIMPLE_IMAGE_FILENAME.test(name) &&
    !name.includes("..") &&
    IMAGE_EXTENSIONS.test(extension);
}

/** 선두 BOM을 허용하고, 첫 줄의 YAML frontmatter만 안전하게 제거한다. */
export function stripFrontmatter(markdown: string): string {
  const source = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const firstBreak = source.indexOf("\n");
  const firstLine = (firstBreak < 0 ? source : source.slice(0, firstBreak))
    .replace(/\r$/, "");
  if (firstLine !== "---") return source;

  let cursor = firstBreak < 0 ? source.length : firstBreak + 1;
  while (cursor < source.length) {
    const nextBreak = source.indexOf("\n", cursor);
    const lineEnd = nextBreak < 0 ? source.length : nextBreak;
    const line = source.slice(cursor, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return nextBreak < 0 ? "" : source.slice(nextBreak + 1);
    }
    cursor = nextBreak < 0 ? source.length : nextBreak + 1;
  }

  // 닫는 delimiter가 없으면 사용자가 작성한 원문을 보존한다.
  return source;
}

/** 코드 펜스·인라인 코드 안의 Obsidian 링크는 보존하면서 링크만 변환한다. */
export function preprocessObsidianMarkdown(markdown: string, imageAliases: Record<string, string> = {}): string {
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    const token = `\uE000KORDOC_CODE_${protectedParts.length}\uE001`;
    protectedParts.push(value);
    return token;
  };

  let outsideCode = "";
  let index = 0;
  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";
    if (atLineStart) {
      const lineEnd = markdown.indexOf("\n", index);
      const end = lineEnd < 0 ? markdown.length : lineEnd;
      const line = markdown.slice(index, end);
      const fence = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const marker = fence[2][0];
        const markerLength = fence[2].length;
        let blockEnd = markdown.length;
        let cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
        while (cursor < markdown.length) {
          const closingEnd = markdown.indexOf("\n", cursor);
          const closingLineEnd = closingEnd < 0 ? markdown.length : closingEnd;
          const closingLine = markdown.slice(cursor, closingLineEnd);
          const closing = new RegExp(`^ {0,3}${marker}{${markerLength},}[ \\t]*$`);
          if (closing.test(closingLine)) {
            blockEnd = closingEnd < 0 ? markdown.length : closingEnd;
            break;
          }
          cursor = closingEnd < 0 ? markdown.length : closingEnd + 1;
        }
        outsideCode += protect(markdown.slice(index, blockEnd));
        index = blockEnd;
        continue;
      }
    }

    if (markdown[index] === "`") {
      let tickLength = 1;
      while (markdown[index + tickLength] === "`") tickLength++;
      const ticks = "`".repeat(tickLength);
      const close = markdown.indexOf(ticks, index + tickLength);
      if (close >= 0) {
        const end = close + tickLength;
        outsideCode += protect(markdown.slice(index, end));
        index = end;
        continue;
      }
    }

    outsideCode += markdown[index];
    index++;
  }

  let converted = outsideCode.replace(/!\[\[([^\]\n]+)\]\]/g, (_, raw: string) => {
    const target = raw.split("|", 1)[0].trim();
    if (imageAliases[target]) return `![](${imageAliases[target]})`;
    const basename = target.split(/[\\/]/).pop()?.split(/[\^#]/, 1)[0]?.trim() ?? "";
    if (!basename) return raw;
    return isPlaceholderImageFilename(basename) ? `![](${basename})` : basename;
  });

  converted = converted.replace(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g, (whole, alt: string, raw: string) => {
    const target = raw.startsWith("<") ? raw.slice(1, -1) : raw.replace(/\s+["'][^"']*["']\s*$/, "").trim();
    return imageAliases[target] ? `![${alt}](${imageAliases[target]})` : whole;
  });

  converted = converted.replace(/\[\[([^\]\n]+)\]\]/g, (_, raw: string) => {
    const separator = raw.indexOf("|");
    const display = separator >= 0 ? raw.slice(separator + 1).trim() : raw.trim();
    return display || (separator >= 0 ? raw.slice(0, separator).trim() : raw.trim());
  });

  return converted.replace(/\uE000KORDOC_CODE_(\d+)\uE001/g, (_, n: string) => {
    return protectedParts[Number(n)] ?? "";
  });
}

/** 볼트 기준 상대 폴더를 정규화한다. null은 절대경로·상위 탈출·제어문자다. */
export function normalizeVaultRelativeFolder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw) return "";
  // Control characters are not valid in Vault folder paths.
  // eslint-disable-next-line no-control-regex -- Reject control characters in paths.
  if (/^(?:[A-Za-z]:|\/)/.test(raw) || /[\u0000-\u001F]/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) return null;
  return parts.filter((part) => part && part !== ".").join("/");
}

export function normalizeGongmunPreset(value: unknown): GongmunPresetSetting {
  return value === "none" ||
      (typeof value === "string" && (GONGMUN_PRESETS as readonly string[]).includes(value))
    ? value as GongmunPresetSetting
    : "none";
}

export function isMarkdownFilename(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}
