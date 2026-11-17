/** The engine uses section counts as a fallback for Hangul documents. */
export function knownPageCount(result: { fileType?: string; pageCount?: number; metadata?: { pageMode?: string } }): number | undefined {
  if (result.fileType !== "hwp" && result.fileType !== "hwpx") return result.pageCount;
  return result.metadata?.pageMode === "layout" && Number.isInteger(result.pageCount) && (result.pageCount ?? 0) > 0
    ? result.pageCount : undefined;
}

export function withoutUnknownPageCount<T extends { fileType?: string; pageCount?: number; metadata?: { pageMode?: string; pageCount?: number } }>(result: T): T {
  if ((result.fileType !== "hwp" && result.fileType !== "hwpx") || knownPageCount(result) !== undefined) return result;
  const { pageCount: _pageCount, ...rest } = result;
  if (!rest.metadata) return rest as T;
  const { pageCount: _metadataPageCount, ...metadata } = rest.metadata;
  return { ...rest, metadata } as T;
}
