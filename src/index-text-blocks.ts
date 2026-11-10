import type { IRBlock } from './engine';
import { blocksToChunks } from './engine';

/** PDF text sections must not span pages after page-local parsing. */
export function indexTextChunks(blocks: IRBlock[], pdf: boolean) {
  const plain = plainIndexBlocks(blocks);
  if (!pdf) return blocksToChunks(plain, { granularity: 'section', tableFormat: 'gfm' });
  const chunks: ReturnType<typeof blocksToChunks> = [];
  for (let start = 0; start < plain.length;) {
    let end = start + 1;
    while (end < plain.length && plain[end].pageNumber === plain[start].pageNumber) end++;
    for (const chunk of blocksToChunks(plain.slice(start, end), { granularity: 'section', tableFormat: 'gfm' })) {
      chunks.push({ ...chunk, blockRange: [chunk.blockRange[0] + start, chunk.blockRange[1] + start] });
    }
    start = end;
  }
  return chunks;
}

/** parse(plain:true) only flattens markdown, not IR; chunks render that IR again. */
export function plainIndexBlocks(blocks: IRBlock[]): IRBlock[] {
  return blocks.map((block) => ({
    ...block,
    style: undefined,
    spans: block.spans?.map((span) => ({ text: span.text, ...(span.placeholder ? { placeholder: true } : {}) })),
    children: block.children ? plainIndexBlocks(block.children) : undefined,
    footnoteBlocks: block.footnoteBlocks ? plainIndexBlocks(block.footnoteBlocks) : undefined,
    table: block.table ? { ...block.table, cells: block.table.cells.map((row) => row.map((cell) => ({ ...cell, blocks: cell.blocks ? plainIndexBlocks(cell.blocks) : undefined }))), captionBlocks: block.table.captionBlocks ? plainIndexBlocks(block.table.captionBlocks) : undefined } : undefined,
  }));
}
