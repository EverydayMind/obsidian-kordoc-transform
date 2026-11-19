import type { App } from "obsidian";

/** Narrow view of the HWP Hands plugin instance. KorDoc never imports HWP Hands code. */
interface HwpHandsPrivacy {
  api?: { privacy?: { isBlocked?: (path: string) => unknown } };
  isAiPrivate?: (path: string) => unknown;
  aiPrivacyNeedsReview?: () => unknown;
}

const HWP_HANDS_ID = "hwp-hands";

/** `X.hwpx.index.md` / `X.hwp.index.md` -> `X.hwpx` / `X.hwp`; otherwise null. */
export function indexNoteDocumentPath(path: string): string | null {
  const match = /^(.*\.hwpx?)\.index\.md$/i.exec(path);
  return match ? match[1] : null;
}

/**
 * True when the user marked this path AI-private in HWP Hands.
 * Fail-closed: any error from the other plugin counts as blocked.
 */
export function isAiPrivatePath(app: App, path: string): boolean {
  try {
    const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
    const hands = plugins?.plugins?.[HWP_HANDS_ID] as HwpHandsPrivacy | undefined;
    if (!hands) return false;
    // HWP 문서와 그 색인 노트만 비공개 대상이다. 목록이 검토 대기일 때 다른 형식까지 막히지 않게 한다.
    if (!/\.hwpx?(?:\.index\.md)?$/i.test(path)) return false;
    const privacy = hands.api?.privacy;
    if (typeof privacy?.isBlocked === "function") return privacy.isBlocked.call(privacy, path) === true;
    if (typeof hands.aiPrivacyNeedsReview === "function" && hands.aiPrivacyNeedsReview.call(hands) === true) return true;
    if (typeof hands.isAiPrivate !== "function") return false;
    if (hands.isAiPrivate.call(hands, path) === true) return true;
    const document = indexNoteDocumentPath(path);
    return document !== null && hands.isAiPrivate.call(hands, document) === true;
  } catch {
    return true;
  }
}
