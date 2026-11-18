import type { ParseResult } from "./engine";
import { knownPageCount } from "./page-count";

export interface FrontmatterBuildOptions {
  pluginVersion: string;
  engineVersion: string;
  convertedAt: string;
}

/** Local wall-clock time with its UTC offset, e.g. 2026-11-19T01:02:03+09:00. */
export function localTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset < 0 ? "-" : "+"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export function yamlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildFrontmatter(
  originalName: string,
  result: ParseResult,
  options: FrontmatterBuildOptions,
): string {
  const lines: string[] = ["---"];
  lines.push(`source: "${yamlEscape(originalName)}"`);
  if (result.success) {
    lines.push(`format: ${result.fileType}`);
    const pageCount = knownPageCount(result);
    if (pageCount != null) lines.push(`pages: ${pageCount}`);
    const meta = result.metadata;
    if (meta?.title) lines.push(`title: "${yamlEscape(meta.title)}"`);
    if (meta?.author) lines.push(`author: "${yamlEscape(meta.author)}"`);
    if (meta?.createdAt) lines.push(`created: "${yamlEscape(meta.createdAt)}"`);
  }
  lines.push(`converted: ${options.convertedAt}`);
  lines.push(`tool: "kordoc-transform ${yamlEscape(options.pluginVersion)} (kordoc ${yamlEscape(options.engineVersion)})"`);
  lines.push("---", "", "");
  return lines.join("\n");
}
