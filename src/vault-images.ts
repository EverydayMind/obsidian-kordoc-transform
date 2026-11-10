import type { App, TFile } from "obsidian";
import MarkdownIt from "markdown-it";

/** Resolve local Obsidian attachments only; URLs are never fetched. */
export async function collectVaultImages(app: App, source: TFile, markdown: string): Promise<{
  aliases: Record<string, string>; images: Record<string, ArrayBuffer>; warnings: string[];
}> {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/!\[\[([^\]\n]+)\]\]/g)) targets.add(match[1].split("|", 1)[0].trim());
  for (const match of markdown.matchAll(/!\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) targets.add(match[1].startsWith("<") ? match[1].slice(1, -1) : match[1].replace(/\s+["'][^"']*["']\s*$/, "").trim());
  const md = new MarkdownIt();
  const renderedTargets = new Set<string>();
  const wikiConverted = markdown.replace(/!\[\[([^\]\n]+)\]\]/g, (_, raw: string) => `![](<${encodeURI(raw.split("|", 1)[0].trim())}>)`);
  for (const token of md.parse(wikiConverted, {})) for (const child of token.children ?? []) if (child.type === "image") renderedTargets.add(child.attrGet("src") ?? "");
  const aliases: Record<string, string> = {}, images: Record<string, ArrayBuffer> = {}, warnings: string[] = [];
  const resolved = new Map<string, string>();
  let total = 0;
  for (const target of targets) {
    if (!renderedTargets.has(md.normalizeLink(target))) continue;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* Keep literal filenames with %. */ }
    const image = app.metadataCache.getFirstLinkpathDest(decoded.split("#", 1)[0], source.path);
    if (!image || !/^(png|jpg|jpeg|gif|bmp)$/i.test(image.extension)) { warnings.push(`이미지를 삽입하지 못했습니다: ${target}`); continue; }
    if (resolved.has(image.path)) { aliases[target] = resolved.get(image.path)!; continue; }
    const data = await app.vault.readBinary(image);
    if (data.byteLength > 40 * 1024 * 1024 || total + data.byteLength > 100 * 1024 * 1024) throw new Error("첨부 이미지의 크기가 허용 범위를 초과했습니다 (개별 40MB·전체 100MB).");
    total += data.byteLength;
    const name = `kordoc-image-${resolved.size + 1}.${image.extension.toLowerCase()}`;
    resolved.set(image.path, name); aliases[target] = name; images[name] = data;
  }
  return { aliases, images, warnings };
}
