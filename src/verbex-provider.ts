import type { App, TFile } from "obsidian";
import {
  renderHwpxToSvg,
  validateHwpx,
  type BlockCapabilityInfo,
  type BlockEdit,
  type IRBlock,
} from "./engine";
import { HwpxEditSession, sha256Hex, type AppliedBlockPatch } from "./hwpx-edit";
import {
  KORDOC_PROVIDER_ID,
  KORDOC_PROVIDER_PROTOCOL_VERSION,
  KORDOC_PROVIDER_SCHEMA,
  KORDOC_PROVIDER_SCHEMA_VERSION,
  KORDOC_PROVIDER_TOOL_NAMES,
  KordocProviderError,
  computeKordocProviderSchemaHash,
  normalizeKordocProviderPath,
  type KordocBinaryChangeDraft,
  type KordocBlockPage,
  type KordocBlockSummary,
  type KordocDocumentInspection,
  type KordocDraftValidation,
  type KordocInspectBlocksInput,
  type KordocInspectDocumentInput,
  type KordocPrepareBlockPatchInput,
  type KordocPrepareBlockPatchResult,
  type KordocProvider,
  type KordocProviderManifest,
  type KordocProviderPath,
  type KordocSemanticChange,
} from "./verbex-contract";

interface SessionRecord {
  path: KordocProviderPath;
  file: TFile;
  sourceHash: string;
  session: HwpxEditSession;
}

const DEFAULT_BLOCK_LIMIT = 20;

function preview(value: string | undefined, maxChars: number): string {
  const text = value ?? "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 3)) + "...";
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function capabilityDto(capability: BlockCapabilityInfo) {
  const dto: {
    kind: "text" | "cell-text" | "locked";
    reason?: string;
    editableCells?: Array<{ row: number; col: number }>;
    editableCellsTruncated?: boolean;
  } = {
    kind: capability.capability,
    ...(capability.reason ? { reason: capability.reason } : {}),
  };
  if (capability.capability !== "cell-text" || !capability.cells) return dto;

  const editableCells: Array<{ row: number; col: number }> = [];
  let truncated = false;
  for (let row = 0; row < capability.cells.length; row++) {
    for (let col = 0; col < (capability.cells[row]?.length ?? 0); col++) {
      if (!capability.cells[row]?.[col]?.editable) continue;
      if (editableCells.length < KORDOC_PROVIDER_SCHEMA.limits.editableCellCoordinates) {
        editableCells.push({ row, col });
      } else {
        truncated = true;
      }
    }
  }
  dto.editableCells = editableCells;
  if (truncated) dto.editableCellsTruncated = true;
  return dto;
}

function blockSummary(
  block: IRBlock,
  blockIndex: number,
  capability: BlockCapabilityInfo,
): KordocBlockSummary {
  return {
    blockIndex,
    type: block.type,
    ...(block.text !== undefined
      ? { textPreview: preview(block.text, KORDOC_PROVIDER_SCHEMA.limits.textPreviewChars) }
      : {}),
    ...(block.table
      ? { tableShape: { rows: block.table.rows, cols: block.table.cols } }
      : {}),
    capability: capabilityDto(capability),
  };
}

type ProviderErrorCode = ConstructorParameters<typeof KordocProviderError>[0];

function providerError(code: ProviderErrorCode, message: string): KordocProviderError {
  return new KordocProviderError(code, message);
}

/**
 * Importer-side implementation of the v1 provider contract.
 * It never writes to the Vault. Binary drafts are host-only data for Verbex
 * proposal storage, approval, checkpointing, and the final Vault write.
 */
export class KordocProviderService implements KordocProvider {
  private readonly sessions = new Map<string, SessionRecord>();
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly providerVersion: string,
    private readonly viewPaths: () => string[] = () => [],
  ) {}

  async openDocumentPaths(): Promise<string[]> {
    this.ensureActive();
    return [...new Set(this.viewPaths().map(normalizeKordocProviderPath))];
  }

  async getManifest(): Promise<KordocProviderManifest> {
    this.ensureActive();
    return {
      providerId: KORDOC_PROVIDER_ID,
      protocolVersion: KORDOC_PROVIDER_PROTOCOL_VERSION,
      schemaVersion: KORDOC_PROVIDER_SCHEMA_VERSION,
      schemaHash: await computeKordocProviderSchemaHash(),
      providerVersion: this.providerVersion,
      capabilities: {
        inspectDocument: true,
        inspectBlocks: true,
        prepareBlockPatch: true,
        validateHwpx: true,
        binaryDraft: true,
        commit: false,
      },
      llmToolNames: KORDOC_PROVIDER_TOOL_NAMES,
    };
  }

  async inspectDocument(input: KordocInspectDocumentInput): Promise<KordocDocumentInspection> {
    this.ensureActive();
    const record = await this.ensureSession(input.path);
    const rendered = await renderHwpxToSvg(record.session.bytes, { reflow: true });
    return {
      path: record.path,
      format: "hwpx",
      pageCount: rendered.pageCount,
      warnings: rendered.warnings,
      blockCount: record.session.blocks.length,
      sessionRevision: record.session.sessionRevision,
      sourceHash: record.sourceHash,
    };
  }

  async inspectBlocks(input: KordocInspectBlocksInput): Promise<KordocBlockPage> {
    this.ensureActive();
    const offset = input.offset ?? 0;
    const requestedLimit = input.limit ?? DEFAULT_BLOCK_LIMIT;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw providerError("INVALID_INPUT", "offset must be >= 0 and limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, KORDOC_PROVIDER_SCHEMA.limits.blockPageLimit);
    const record = await this.ensureSession(input.path);
    const total = record.session.blocks.length;
    const blocks = record.session.blocks
      .slice(offset, offset + limit)
      .map((block, relativeIndex) =>
        blockSummary(block, offset + relativeIndex, record.session.capability(offset + relativeIndex))
      );
    const page: KordocBlockPage = {
      path: record.path,
      sourceHash: record.sourceHash,
      sessionRevision: record.session.sessionRevision,
      offset,
      limit,
      total,
      blocks,
      ...(offset + blocks.length < total ? { nextOffset: offset + blocks.length } : {}),
    };
    if (jsonByteLength(page) > KORDOC_PROVIDER_SCHEMA.limits.responseBytes) {
      throw providerError("RESPONSE_LIMIT", "inspect_blocks response exceeds the contract byte limit.");
    }
    return page;
  }

  async prepareBlockPatch(input: KordocPrepareBlockPatchInput): Promise<KordocPrepareBlockPatchResult> {
    this.ensureActive();
    const record = await this.ensureSession(input.path);
    if (input.sessionRevision !== record.session.sessionRevision) {
      throw providerError(
        "STALE_SESSION_REVISION",
        `session revision is stale: expected=${record.session.sessionRevision}, received=${input.sessionRevision}`,
      );
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw providerError("INVALID_INPUT", "edits must contain at least one block edit.");
    }
    const limits = KORDOC_PROVIDER_SCHEMA.limits;
    if (input.edits.length > limits.maxPatchEdits) {
      throw providerError("INVALID_INPUT", `edits may contain at most ${limits.maxPatchEdits} block edits.`);
    }
    if (jsonByteLength(input.edits) > limits.maxPatchBytes) {
      throw providerError("RESPONSE_LIMIT", `patch payload exceeds ${limits.maxPatchBytes} bytes.`);
    }
    for (const edit of input.edits) {
      if (edit.newText !== undefined && edit.newText.length > limits.maxTextChars) {
        throw providerError("INVALID_INPUT", `newText may contain at most ${limits.maxTextChars} characters.`);
      }
      if (edit.cells && edit.cells.length > limits.maxCellEdits) {
        throw providerError("INVALID_INPUT", `cells may contain at most ${limits.maxCellEdits} cell edits per block.`);
      }
      for (const cell of edit.cells ?? []) {
        if (cell.text.length > limits.maxTextChars) {
          throw providerError("INVALID_INPUT", `cell text may contain at most ${limits.maxTextChars} characters.`);
        }
      }
    }

    // Work on a clone. Preparing a proposal must not mutate the importer
    // session before Verbex has approved and committed it.
    const working = await HwpxEditSession.open(record.session.bytes);
    let applied: AppliedBlockPatch;
    try {
      applied = await working.patch(input.edits, working.sessionRevision);
    } catch (error) {
      throw providerError(
        "PATCH_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    const changes = summarizeChanges(record.session.blocks, working.blocks, input.edits);
    const resultHash = await sha256Hex(applied.bytes);
    const draft: KordocBinaryChangeDraft = {
      kind: "binary-change-draft",
      providerId: KORDOC_PROVIDER_ID,
      providerProtocolVersion: KORDOC_PROVIDER_PROTOCOL_VERSION,
      providerVersion: this.providerVersion,
      targetPath: record.path,
      sourceHash: record.sourceHash,
      resultHash,
      baseSessionRevision: record.session.sessionRevision,
      resultSessionRevision: record.session.sessionRevision + 1,
      applied: applied.result.applied,
      changes,
      data: new Uint8Array(applied.bytes),
      context: input.context,
    };
    return {
      draft,
      summary: {
        targetPath: record.path,
        sourceHash: record.sourceHash,
        resultHash,
        baseSessionRevision: record.session.sessionRevision,
        resultSessionRevision: record.session.sessionRevision + 1,
        applied: applied.result.applied,
        changes,
        requiresHostApproval: true,
        containsBinaryData: false,
      },
    };
  }

  async validateDraft(draft: KordocBinaryChangeDraft): Promise<KordocDraftValidation> {
    this.ensureActive();
    const issues: Array<{ path?: string; message: string }> = [];
    let targetPath: KordocProviderPath;
    try {
      targetPath = normalizeKordocProviderPath(draft.targetPath);
    } catch (error) {
      return {
        ok: false,
        resultHash: draft.resultHash,
        issues: [{ message: error instanceof Error ? error.message : String(error) }],
      };
    }
    if (draft.providerId !== KORDOC_PROVIDER_ID) {
      issues.push({ message: "draft providerId does not match kordoc-transform." });
    }
    if (draft.providerProtocolVersion !== KORDOC_PROVIDER_PROTOCOL_VERSION) {
      issues.push({ message: "draft provider protocol version does not match." });
    }
    const actualHash = await sha256Hex(draft.data);
    if (actualHash !== draft.resultHash) {
      issues.push({ message: "draft resultHash does not match binary data." });
    }
    const validation = await validateHwpx(draft.data);
    if (!validation.ok) {
      issues.push(...validation.issues.map((issue) => ({ path: issue.path, message: issue.message })));
    }
    try {
      const record = await this.ensureSession(targetPath);
      if (record.sourceHash !== draft.sourceHash) {
        issues.push({ message: "current Vault sourceHash differs from the draft base hash." });
      }
      if (record.session.sessionRevision !== draft.baseSessionRevision) {
        issues.push({ message: "current importer session revision differs from the draft base revision." });
      }
    } catch (error) {
      issues.push({ message: error instanceof Error ? error.message : String(error) });
    }
    return {
      ok: issues.length === 0,
      resultHash: actualHash,
      entryCount: validation.entryCount,
      issues,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.clear();
  }

  private ensureActive(): void {
    if (this.disposed) throw providerError("DISPOSED", "kordoc provider is disposed.");
  }

  private async ensureSession(pathInput: KordocProviderPath | string): Promise<SessionRecord> {
    const path = normalizeKordocProviderPath(pathInput);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!isVaultFile(abstract)) {
      throw providerError("NOT_FOUND", `HWPX file not found in Vault: ${path}`);
    }
    if (abstract.extension.toLowerCase() !== "hwpx") {
      throw providerError("UNSUPPORTED_FORMAT", "kordoc provider supports HWPX files only.");
    }
    const bytes = new Uint8Array(await this.app.vault.readBinary(abstract));
    const sourceHash = await sha256Hex(bytes);
    const cached = this.sessions.get(path);
    if (cached && cached.file === abstract && cached.sourceHash === sourceHash) return cached;
    let session: HwpxEditSession;
    try {
      session = await HwpxEditSession.open(bytes);
    } catch (error) {
      throw providerError(
        "UNSUPPORTED_FORMAT",
        error instanceof Error ? error.message : String(error),
      );
    }
    const record = { path, file: abstract, sourceHash, session };
    this.sessions.set(path, record);
    return record;
  }
}

/** Runtime-safe TFile guard. Obsidian's TFile class is not available in
 * headless tests, while the provider only needs the stable file fields here. */
function isVaultFile(value: unknown): value is TFile {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { path?: unknown }).path === "string" &&
      typeof (value as { extension?: unknown }).extension === "string",
  );
}

function summarizeChanges(
  beforeBlocks: IRBlock[],
  afterBlocks: IRBlock[],
  edits: BlockEdit[],
): KordocSemanticChange[] {
  const maxChars = KORDOC_PROVIDER_SCHEMA.limits.changePreviewChars;
  const changes: KordocSemanticChange[] = [];
  for (const edit of edits) {
    const before = beforeBlocks[edit.blockIndex];
    const after = afterBlocks[edit.blockIndex];
    if (!before || !after) continue;
    if (edit.newText !== undefined) {
      changes.push({
        blockIndex: edit.blockIndex,
        kind: "text",
        beforePreview: preview(before.text, maxChars),
        afterPreview: preview(after.text, maxChars),
      });
    }
    for (const cellEdit of edit.cells ?? []) {
      changes.push({
        blockIndex: edit.blockIndex,
        kind: "cell",
        row: cellEdit.row,
        col: cellEdit.col,
        beforePreview: preview(before.table?.cells[cellEdit.row]?.[cellEdit.col]?.text, maxChars),
        afterPreview: preview(after.table?.cells[cellEdit.row]?.[cellEdit.col]?.text, maxChars),
      });
    }
  }
  return changes;
}
