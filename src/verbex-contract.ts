import type { BlockEdit, IRBlock } from "./engine";

/** importer ↔ Verbex provider registry의 프로토콜 버전. */
export const KORDOC_PROVIDER_PROTOCOL_VERSION = 1 as const;
export const VERBEX_PROVIDER_HOST_PROTOCOL_VERSION = 1 as const;
/** KORDOC가 Verbex 채팅에 사용자 요청을 전달하는 UI 브리지 버전. */
export const VERBEX_CHAT_HOST_PROTOCOL_VERSION = 1 as const;
export const KORDOC_PROVIDER_ID = "kordoc-transform" as const;
export const KORDOC_PROVIDER_SCHEMA_VERSION = "1.0.0" as const;

export const KORDOC_PROVIDER_TOOL_NAMES = [
  "kordoc__inspect_document",
  "kordoc__inspect_blocks",
  "kordoc__prepare_block_patch",
] as const;

export type KordocProviderToolName = (typeof KORDOC_PROVIDER_TOOL_NAMES)[number];

export type HwpEditScope = {
  /** Host-selected document context. A single-block scope is an edit lock. */
  scope: "document" | "single-block";
  operation: "transform";
  /** One-shot correlation id issued by the companion host for this turn. */
  contextId: string;
  path: string;
  sourceHash: string;
  blockIndex?: number;
  blockType?: "paragraph" | "heading" | "table";
  tableShape?: { rows: number; cols: number };
  targetCell?: { row: number; col: number };
  tableCells?: Array<{ row: number; col: number; text: string }>;
  tableCellsTruncated?: boolean;
};

export type ChatSubmissionResult =
  | { status: "submitted"; messageId: string }
  | { status: "selection_required"; messageId: string }
  | { status: "busy"; reason?: string }
  | { status: "not_ready"; reason: string }
  | { status: "rejected"; reason: string };

export type VerbexChatSubmissionOptions = {
  scope?: HwpEditScope;
};

/**
 * schemaHash를 계산할 때 사용하는 순서 고정 계약 원문.
 * JSON schema 파일을 별도 배포하지 않는 독립 플러그인 간 계약이므로,
 * 양쪽은 이 필드와 계산 결과를 handshake에서 비교한다.
 */
export const KORDOC_PROVIDER_SCHEMA = {
  protocolVersion: KORDOC_PROVIDER_PROTOCOL_VERSION,
  hostProtocolVersion: VERBEX_PROVIDER_HOST_PROTOCOL_VERSION,
  schemaVersion: KORDOC_PROVIDER_SCHEMA_VERSION,
  providerId: KORDOC_PROVIDER_ID,
  path: "vault-relative-posix-no-parent-or-absolute",
  llmTools: KORDOC_PROVIDER_TOOL_NAMES,
  hostOnly: [
    "validate_draft",
    "checkpoint_binary",
    "commit_binary",
  ],
  limits: {
    blockPageLimit: 50,
    textPreviewChars: 240,
    changePreviewChars: 512,
    responseBytes: 65536,
    editableCellCoordinates: 512,
    maxPatchEdits: 16,
    maxCellEdits: 128,
    maxTextChars: 20000,
    maxPatchBytes: 65536,
  },
} as const;

export type KordocProviderPath = string & { readonly __kordocVaultPath: unique symbol };

export interface KordocProviderManifest {
  providerId: typeof KORDOC_PROVIDER_ID;
  protocolVersion: typeof KORDOC_PROVIDER_PROTOCOL_VERSION;
  schemaVersion: typeof KORDOC_PROVIDER_SCHEMA_VERSION;
  schemaHash: `sha256:${string}`;
  providerVersion: string;
  capabilities: {
    inspectDocument: true;
    inspectBlocks: true;
    prepareBlockPatch: true;
    validateHwpx: true;
    binaryDraft: true;
    commit: false;
  };
  llmToolNames: readonly KordocProviderToolName[];
}

export interface KordocProviderContext {
  runId?: string;
  turnId?: string;
  registrySnapshotId?: string;
  providerGeneration?: string;
}

export interface KordocInspectDocumentInput {
  path: KordocProviderPath | string;
}

export interface KordocDocumentInspection {
  path: KordocProviderPath;
  format: "hwpx";
  pageCount: number;
  warnings: string[];
  blockCount: number;
  sessionRevision: number;
  sourceHash: string;
}

export interface KordocInspectBlocksInput {
  path: KordocProviderPath | string;
  offset?: number;
  limit?: number;
}

export interface KordocTableShape {
  rows: number;
  cols: number;
}

export interface KordocCapabilityDto {
  kind: "text" | "cell-text" | "locked";
  reason?: string;
  editableCells?: Array<{ row: number; col: number }>;
  editableCellsTruncated?: boolean;
}

export interface KordocBlockSummary {
  blockIndex: number;
  type: IRBlock["type"];
  textPreview?: string;
  tableShape?: KordocTableShape;
  capability: KordocCapabilityDto;
}

export interface KordocBlockPage {
  path: KordocProviderPath;
  sourceHash: string;
  sessionRevision: number;
  offset: number;
  limit: number;
  total: number;
  blocks: KordocBlockSummary[];
  nextOffset?: number;
}

export interface KordocPrepareBlockPatchInput {
  path: KordocProviderPath | string;
  sessionRevision: number;
  edits: BlockEdit[];
  context?: KordocProviderContext;
}

export interface KordocSemanticChange {
  blockIndex: number;
  kind: "text" | "cell";
  row?: number;
  col?: number;
  beforePreview: string;
  afterPreview: string;
}

/**
 * Verbex host가 bounded proposal store에 복사해 보관할 내부 초안.
 * `data`는 LLM ToolResult로 직렬화하면 안 된다.
 */
export interface KordocBinaryChangeDraft {
  kind: "binary-change-draft";
  providerId: typeof KORDOC_PROVIDER_ID;
  providerProtocolVersion: typeof KORDOC_PROVIDER_PROTOCOL_VERSION;
  providerVersion: string;
  targetPath: KordocProviderPath;
  sourceHash: string;
  resultHash: string;
  baseSessionRevision: number;
  resultSessionRevision: number;
  applied: number;
  changes: KordocSemanticChange[];
  data: Uint8Array;
  context?: KordocProviderContext;
}

/** provider가 host에 돌려주는 패치 요약. proposalId는 Verbex가 생성한다. */
export interface KordocPrepareSummary {
  targetPath: KordocProviderPath;
  sourceHash: string;
  resultHash: string;
  baseSessionRevision: number;
  resultSessionRevision: number;
  applied: number;
  changes: KordocSemanticChange[];
  requiresHostApproval: true;
  containsBinaryData: false;
}

export interface KordocPrepareBlockPatchResult {
  draft: KordocBinaryChangeDraft;
  summary: KordocPrepareSummary;
}

export interface KordocDraftValidation {
  ok: boolean;
  resultHash: string;
  entryCount?: number;
  issues: Array<{ path?: string; message: string }>;
}

export interface KordocProvider {
  getManifest(): Promise<KordocProviderManifest>;
  /** Optional host-only metadata. No document text or editing permission. */
  openDocumentPaths?(): Promise<string[]>;
  inspectDocument(input: KordocInspectDocumentInput): Promise<KordocDocumentInspection>;
  inspectBlocks(input: KordocInspectBlocksInput): Promise<KordocBlockPage>;
  prepareBlockPatch(input: KordocPrepareBlockPatchInput): Promise<KordocPrepareBlockPatchResult>;
  /** LLM 도구가 아닌 Verbex host 내부 검증 callback. */
  validateDraft(draft: KordocBinaryChangeDraft): Promise<KordocDraftValidation>;
  dispose(): void;
}

export interface KordocImporterApi {
  styleProfile?: import('./style-profile-api').StyleProfileApiV1;
  indexTextVersion?: 1;
  indexTextExtractor?: typeof import("./index-text").INDEX_TEXT_EXTRACTOR;
  indexText?: ReturnType<typeof import("./index-text").createIndexText>;
  protocolVersion: typeof KORDOC_PROVIDER_PROTOCOL_VERSION;
  provider: KordocProvider;
  /** Independent document tools; the v1 Verbex provider protocol is unchanged. */
  tools?: {
    list(): ReadonlyArray<{ name: string }>;
    execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface VerbexProviderRegistration {
  dispose(): void;
}

/** Verbex가 importer provider를 등록받기 위해 제공해야 하는 최소 API. */
export interface VerbexProviderRegistry {
  protocolVersion: typeof VERBEX_PROVIDER_HOST_PROTOCOL_VERSION;
  generation: string;
  registerProvider(provider: KordocProvider): VerbexProviderRegistration;
}

/**
 * HWPX 미리보기 같은 외부 UI가 Verbex의 정상 채팅 제출 경로를 호출하기
 * 위한 최소 API. 요청 본문은 Verbex가 그대로 사용자 메시지로 취급한다.
 */
export interface VerbexChatApi {
  protocolVersion: typeof VERBEX_CHAT_HOST_PROTOCOL_VERSION;
  sendMessage(message: string): Promise<boolean>;
  sendMessageV2?(
    message: string,
    options?: VerbexChatSubmissionOptions,
  ): Promise<ChatSubmissionResult>;
}

export type KordocProviderErrorCode =
  | "INVALID_PATH"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNSUPPORTED_FORMAT"
  | "STALE_SESSION_REVISION"
  | "PATCH_FAILED"
  | "RESPONSE_LIMIT"
  | "DISPOSED"
  | "PROTOCOL_MISMATCH";

export class KordocProviderError extends Error {
  constructor(
    readonly code: KordocProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KordocProviderError";
  }
}

/** 절대경로·상위 탈출·제어문자를 거부하는 볼트 상대경로 정규화. */
export function normalizeKordocProviderPath(value: unknown): KordocProviderPath {
  if (typeof value !== "string") {
    throw new KordocProviderError("INVALID_PATH", "경로는 문자열이어야 합니다.");
  }
  const raw = value.trim().replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex -- Reject control characters in provider paths.
  if (!raw || /^(?:[A-Za-z]:|\/)/.test(raw) || /[\u0000-\u001F]/.test(raw)) {
    throw new KordocProviderError(
      "INVALID_PATH",
      "provider 경로는 볼트 기준 상대경로여야 하며 절대경로를 사용할 수 없습니다.",
    );
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) {
    throw new KordocProviderError(
      "INVALID_PATH",
      "provider 경로에서 상위 디렉터리 이동(..)은 허용되지 않습니다.",
    );
  }
  const normalized = parts.filter((part) => part && part !== ".").join("/");
  if (!normalized) {
    throw new KordocProviderError("INVALID_PATH", "빈 provider 경로는 허용되지 않습니다.");
  }
  return normalized as KordocProviderPath;
}

function canonicalSchemaText(): string {
  return JSON.stringify(KORDOC_PROVIDER_SCHEMA);
}

/** Manifest handshake용 schema hash. JSON property 순서는 위 상수에서 고정된다. */
export async function computeKordocProviderSchemaHash(): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalSchemaText());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}
