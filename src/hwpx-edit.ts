import {
  openHwpxDocument,
  validateHwpx,
  type BlockCapabilityInfo,
  type BlockEdit,
  type HwpxSession,
  type IRBlock,
  type PatchResult,
} from "./engine";
import { guardZipInput } from "./zip-input-guard";

export interface ParsedEditCommand {
  matched: boolean;
  kind?: "paragraph" | "table";
  edits?: BlockEdit[];
  message?: string;
}

export interface AppliedBlockPatch {
  result: PatchResult;
  revision: number;
  bytes: Uint8Array;
}

const SAFE_FALLBACK_MESSAGE =
  "이해하지 못했습니다. 예: ‘3번째 문단을 새 내용으로 바꿔줘’ 또는 ‘표 2행 3열 값을 새 값으로 바꿔줘’.";

/** Uint8Array의 실제 view 범위를 보존한 ArrayBuffer를 반환한다. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** SHA-256 hex digest. sourceHash와 패치 결과 식별에 공통으로 사용한다. */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const input = bytes instanceof Uint8Array ? toArrayBuffer(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

/** 저장 직전 볼트 원본이 세션 기준과 같은지 확인한다. */
export function assertSourceHash(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(
      "원본 파일이 세션을 연 뒤 변경되었습니다. 저장하지 않고 파일을 다시 여세요.",
    );
  }
}

/** 패치 결과의 skip 정보를 사용자에게 노출할 안전한 메시지로 만든다. */
export function formatPatchSkips(skipped: PatchResult["skipped"]): string {
  if (skipped.length === 0) return "";
  return skipped.map((item, index) => {
    const partial = item.partial ? " (부분 적용)" : "";
    return `${index + 1}. 편집${partial}: ${item.reason}`;
  }).join("\n");
}

/** 표준 HWPX 이미지 토큰을 추출한다. 셀 텍스트 수정 시 토큰 손실을 막는다. */
function imageTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/!\[[^\]]*\]\([^)]*\)|\[이미지:[^\]]*\]/g)) {
    tokens.add(match[0]);
  }
  return [...tokens];
}

function isTextBlock(block: IRBlock): boolean {
  return block.type === "paragraph" || block.type === "heading";
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length < 2) return text;
  const pairs: Array<[string, string]> = [
    ["\"", "\""],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

function commandTail(): string {
  return String.raw`(?:바꿔|변경(?:해)?|수정(?:해)?)(?:\s*(?:줘|주세요|주십시오))?`;
}

/**
 * 1차 오프라인 명령 팔레트.
 * 자연어를 임의로 추측하지 않고 문서에 명시한 두 패턴만 해석한다.
 */
export function parseEditCommand(
  prompt: string,
  blocks: IRBlock[],
): ParsedEditCommand {
  const input = prompt.trim();
  if (!input) return { matched: false, message: SAFE_FALLBACK_MESSAGE };

  const paragraphRe = new RegExp(
    String.raw`^(\d+)\s*(?:번째|번(?:째)?)\s*(?:문단|단락)\s*(?:을|를)\s*(.+?)\s*(?:으로|로)\s*${commandTail()}[.!。]?\s*$`,
  );
  const paragraphMatch = paragraphRe.exec(input);
  if (paragraphMatch) {
    const ordinal = Number(paragraphMatch[1]);
    const replacement = unquote(paragraphMatch[2]);
    const paragraphBlocks = blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(({ block }) => isTextBlock(block));
    const target = paragraphBlocks[ordinal - 1];
    if (!target) {
      return {
        matched: true,
        kind: "paragraph",
        message: `${ordinal}번째 문단을 찾지 못했습니다. 문서의 문단 수는 ${paragraphBlocks.length}개입니다.`,
      };
    }
    if (!replacement) {
      return { matched: true, kind: "paragraph", message: "새 문단 내용이 비어 있습니다." };
    }
    return {
      matched: true,
      kind: "paragraph",
      edits: [{ blockIndex: target.blockIndex, newText: replacement }],
    };
  }

  // "표 2행 3열"을 기본으로 첫 번째 표에 적용하고,
  // "2번째 표의 2행 3열"처럼 표 순번을 명시한 형태도 허용한다.
  const tableRe = new RegExp(
    String.raw`^(?:이\s*)?(?:(\d+)\s*번째\s*)?표\s*(?:의\s*)?(\d+)\s*행\s*(\d+)\s*열\s*(?:값\s*)?(?:을|를)?\s*(.+?)\s*(?:으로|로)\s*${commandTail()}[.!。]?\s*$`,
  );
  const tableMatch = tableRe.exec(input);
  if (tableMatch) {
    const tableOrdinal = tableMatch[1] ? Number(tableMatch[1]) : 1;
    const row = Number(tableMatch[2]);
    const col = Number(tableMatch[3]);
    const replacement = unquote(tableMatch[4]);
    const tables = blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(({ block }) => block.type === "table" && block.table);
    const target = tables[tableOrdinal - 1];
    if (!target?.block.table) {
      return {
        matched: true,
        kind: "table",
        message: `${tableOrdinal}번째 표를 찾지 못했습니다. 문서의 표 수는 ${tables.length}개입니다.`,
      };
    }
    if (row < 1 || col < 1 || row > target.block.table.rows || col > target.block.table.cols) {
      return {
        matched: true,
        kind: "table",
        message: `표 범위를 벗어났습니다. 현재 표는 ${target.block.table.rows}행 ${target.block.table.cols}열입니다.`,
      };
    }
    if (!replacement) {
      return { matched: true, kind: "table", message: "새 셀 내용이 비어 있습니다." };
    }
    return {
      matched: true,
      kind: "table",
      edits: [{
        blockIndex: target.blockIndex,
        cells: [{ row: row - 1, col: col - 1, text: replacement }],
      }],
    };
  }

  return { matched: false, message: SAFE_FALLBACK_MESSAGE };
}

/**
 * kordoc HwpxSession의 mutable 상태를 UI에서 안전하게 사용하기 위한 래퍼.
 * sessionRevision과 sourceHash는 서로 다른 충돌을 막으므로 별도로 유지한다.
 */
export class HwpxEditSession {
  private constructor(
    private session: HwpxSession,
    private originalSourceHash: string,
  ) {}

  private revision = 0;
  private dirty = false;

  static async open(bytes: Uint8Array | ArrayBuffer): Promise<HwpxEditSession> {
    const copied = bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.slice(0));
    await guardZipInput(copied);
    const validation = await validateHwpx(copied);
    if (!validation.ok) {
      throw new Error(`유효하지 않은 HWPX입니다.\n${validation.issues.map((i) => i.message).join("\n")}`);
    }
    return new HwpxEditSession(
      await openHwpxDocument(copied),
      await sha256Hex(copied),
    );
  }

  get blocks(): IRBlock[] {
    return this.session.blocks;
  }

  get bytes(): Uint8Array {
    return this.session.bytes;
  }

  get sessionRevision(): number {
    return this.revision;
  }

  get sourceHash(): string {
    return this.originalSourceHash;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  capability(blockIndex: number): BlockCapabilityInfo {
    return this.session.capability(blockIndex);
  }

  capabilities(): BlockCapabilityInfo[] {
    return this.session.capabilities();
  }

  /** 저장 성공 후 볼트 원본 기준을 새 바이트로 갱신한다. */
  async markSaved(bytes: Uint8Array): Promise<void> {
    this.originalSourceHash = await sha256Hex(bytes);
    this.dirty = false;
    this.revision += 1;
  }

  /** 현재 세션 상태를 새로 읽어 stale 방지 기준을 유지한다. */
  async reload(bytes: Uint8Array): Promise<void> {
    const copied = new Uint8Array(bytes);
    await guardZipInput(copied);
    const validation = await validateHwpx(copied);
    if (!validation.ok) throw new Error("다시 읽은 파일이 유효한 HWPX가 아닙니다.");
    this.session = await openHwpxDocument(copied);
    this.originalSourceHash = await sha256Hex(copied);
    this.dirty = false;
    this.revision += 1;
  }

  async patch(
    edits: BlockEdit[],
    expectedRevision = this.revision,
  ): Promise<AppliedBlockPatch> {
    if (expectedRevision !== this.revision) {
      throw new Error(
        `문서가 변경되어 오래된 편집 요청을 적용하지 않았습니다. ` +
        `최신 revision=${this.revision}을 사용하세요.`,
      );
    }
    this.validateEdits(edits);
    const before = this.session.bytes;
    const result = await this.session.patchBlocks(edits);
    const partial = (result as PatchResult & { partial?: boolean }).partial === true;
    if (!result.success || !result.data || result.skipped.length > 0 || partial) {
      // session.patchBlocks가 일부를 적용했을 가능성이 있으므로 UI 상태도 원복한다.
      this.session = await openHwpxDocument(before);
      const detail = result.skipped.length > 0
        ? `\n${formatPatchSkips(result.skipped)}`
        : "";
      throw new Error(result.error ?? `HWPX 패치가 완전히 적용되지 않았습니다.${detail}`);
    }

    const validation = await validateHwpx(result.data);
    if (!validation.ok) {
      this.session = await openHwpxDocument(before);
      throw new Error(
        `패치 결과가 유효한 HWPX가 아닙니다.\n${validation.issues.map((i) => i.message).join("\n")}`,
      );
    }

    this.revision += 1;
    this.dirty = true;
    return { result, revision: this.revision, bytes: new Uint8Array(result.data) };
  }

  private validateEdits(edits: BlockEdit[]): void {
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error("적용할 편집 내용이 없습니다.");
    }
    const seenBlocks = new Set<number>();
    for (const edit of edits) {
      if (!Number.isInteger(edit.blockIndex) || seenBlocks.has(edit.blockIndex)) {
        throw new Error(`중복되었거나 올바르지 않은 블록 인덱스입니다: ${edit.blockIndex}`);
      }
      seenBlocks.add(edit.blockIndex);
      const block = this.blocks[edit.blockIndex];
      if (!block) throw new Error(`블록 인덱스 범위 밖입니다: ${edit.blockIndex}`);
      const capability = this.capability(edit.blockIndex);

      if (isTextBlock(block)) {
        if (capability.capability !== "text") {
          throw new Error(capability.reason ?? "이 문단은 편집할 수 없습니다.");
        }
        if (typeof edit.newText !== "string" || !edit.newText.trim()) {
          throw new Error("문단을 빈 문자열로 만들 수 없습니다.");
        }
        if (edit.cells?.length) throw new Error("문단 블록에는 셀 편집을 적용할 수 없습니다.");
        continue;
      }

      if (block.type === "table" && block.table) {
        if (capability.capability !== "cell-text") {
          throw new Error(capability.reason ?? "이 표는 편집할 수 없습니다.");
        }
        if (!edit.cells?.length) throw new Error("표 블록에는 셀 편집이 필요합니다.");
        const seenCells = new Set<string>();
        for (const cellEdit of edit.cells) {
          const key = `${cellEdit.row}:${cellEdit.col}`;
          if (seenCells.has(key)) throw new Error(`같은 셀을 여러 번 편집할 수 없습니다: ${key}`);
          seenCells.add(key);
          const cell = block.table.cells[cellEdit.row]?.[cellEdit.col];
          const cellCapability = capability.cells?.[cellEdit.row]?.[cellEdit.col];
          if (!cell || !cellCapability?.editable) {
            throw new Error(cellCapability?.reason ?? `편집할 수 없는 셀입니다: ${key}`);
          }
          if (typeof cellEdit.text !== "string") throw new Error(`셀 값이 문자열이 아닙니다: ${key}`);
          const tokens = imageTokens(cell.text ?? "");
          if (tokens.some((token) => !cellEdit.text.includes(token))) {
            throw new Error(`셀 ${key}의 이미지 토큰을 보존해야 합니다.`);
          }
        }
        if (edit.newText !== undefined) throw new Error("표 블록에는 newText 대신 cells를 사용하세요.");
        continue;
      }

      throw new Error(`${block.type} 블록 편집은 1차 범위에서 지원하지 않습니다.`);
    }
  }
}

/** 다른 이름으로 저장할 편집본 경로를 계산한다. 첫 충돌부터 -편집-2를 사용한다. */
export async function nextAvailableHwpxPath(
  originalPath: string,
  exists: (path: string) => Promise<boolean> | boolean,
): Promise<string> {
  const slash = originalPath.lastIndexOf("/");
  const folder = slash >= 0 ? originalPath.slice(0, slash) : "";
  const filename = slash >= 0 ? originalPath.slice(slash + 1) : originalPath;
  const base = filename.replace(/\.hwpx$/i, "") || "문서";
  const join = (name: string) => folder ? `${folder}/${name}` : name;
  const first = join(`${base}-편집.hwpx`);
  if (!(await exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const candidate = join(`${base}-편집-${i}.hwpx`);
    if (!(await exists(candidate))) return candidate;
  }
  return join(`${base}-편집-${Date.now()}.hwpx`);
}
