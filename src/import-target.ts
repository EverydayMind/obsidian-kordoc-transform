/** 문서 가져오기(변환) 저장 위치·파일 이름 결정용 순수 헬퍼. */
import { normalizeVaultRelativeFolder } from "./export-utils";

/** Windows·Obsidian 에서 폴더 이름으로 쓸 수 없는 문자 */
const INVALID_FOLDER_CHARS = /[\\:*?"<>|#^[\]]/;

/**
 * 기존 폴더(base) 아래에 새 하위 폴더(subfolder, 선택)를 붙여 볼트 기준 경로를 만든다.
 * 절대 경로·`..`·금지 문자가 있으면 null.
 */
export function resolveImportFolder(base: unknown, subfolder: unknown = ""): string | null {
  const parent = normalizeVaultRelativeFolder(base);
  const child = normalizeVaultRelativeFolder(subfolder);
  if (parent === null || child === null) return null;
  for (const part of [...parent.split("/"), ...child.split("/")]) {
    if (INVALID_FOLDER_CHARS.test(part) || /[. ]$/.test(part)) return null;
  }
  return [parent, child].filter(Boolean).join("/");
}

/**
 * 변환 노트의 기본 이름(.md 제외).
 * includeExtension 이면 `보고서.hwpx` → `보고서.hwpx` (저장 시 `보고서.hwpx.md`),
 * 아니면 확장자를 뗀 `보고서`.
 */
export function importNoteBaseName(originalName: string, includeExtension: boolean): string {
  if (includeExtension) return originalName;
  const i = originalName.lastIndexOf(".");
  return i > 0 ? originalName.slice(0, i) : originalName;
}

/** 볼트 경로에서 상위 폴더 경로 (최상위면 "") */
export function parentFolderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}
