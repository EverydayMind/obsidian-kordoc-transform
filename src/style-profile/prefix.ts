/** Records only an observed numbering/bullet token, never the following text.
 * This is a bounded syntactic candidate, not a semantic paragraph-role claim. */
export function visiblePrefix(text: string): string | null {
  const head = [...text].slice(0, 48).join('');
  const match = /^[ \t]{0,8}([□■○●◦ㅇ•※▶▷▪◆◇–—―-]|(?:[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}[.)]?|[IVXLCDMivxlcdm]{1,8}[.)]|[가-하][.)]|[①-⑳]))(?=[ \t]|$)/u.exec(head);
  return match?.[1] ?? null;
}
