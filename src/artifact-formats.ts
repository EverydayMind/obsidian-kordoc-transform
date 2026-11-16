import { getLocale, type Locale } from './locale';

/** Persisted artifact vocabulary. User supplied names and document prose are never translated. */
export const ARTIFACT_FORMATS = {
  generated: { ko: '작성', en: 'generated' },
  filled: { ko: '작성', en: 'filled' },
  comparison: { ko: '비교', en: 'comparison' },
  validation: { ko: '검사', en: 'validation' },
  styleCheck: { ko: '표기검사', en: 'style-check' },
  formatProfile: { ko: '서식', en: 'format-profile' },
  patched: { ko: '반영', en: 'patched' },
  patchReport: { ko: '반영보고', en: 'patch-report' },
  fillReport: { ko: '작성보고', en: 'fill-report' },
  sealed: { ko: '날인', en: 'sealed' },
  sealReport: { ko: '날인보고', en: 'seal-report' },
  redacted: { ko: '마스킹', en: 'redacted' },
  redactionReport: { ko: '마스킹보고', en: 'redaction-report' },
  print: { ko: '인쇄', en: 'print' },
  region: { ko: '영역', en: 'region' },
  regionPage: { ko: '영역-{0}-{1}쪽', en: 'region-{0}-p{1}' },
  page: { ko: '{0}쪽', en: 'p{0}' },
  layout: { ko: '레이아웃', en: 'layout' },
  renderReport: { ko: '렌더보고', en: 'render-report' },
  structure: { ko: '구조', en: 'structure' },
  chunks: { ko: '청크', en: 'chunks' },
  formatEdit: { ko: '서식편집', en: 'format-edit' },
  form: { ko: '양식', en: 'form' },
  table: { ko: '표', en: 'table' },
  document: { ko: '문서', en: 'document' },
  edited: { ko: '{0}-편집.hwpx', en: '{0}-edited.hwpx' },
  editedNumbered: { ko: '{0}-편집-{1}.hwpx', en: '{0}-edited-{1}.hwpx' },
  results: { ko: '{0}-{1}-결과', en: '{0}-{1}-results' },
  generatedDocument: { ko: '작성문서', en: 'generated-document' },
  diagnostics: { ko: '{0}-변환진단', en: '{0}-conversion-diagnostics' },
  convertedDocument: { ko: '변환문서', en: 'converted-document' },
} as const;
export type ArtifactFormat = keyof typeof ARTIFACT_FORMATS;
export function artifactName(key: ArtifactFormat, args: readonly unknown[] = [], locale: Locale = getLocale()): string {
  return ARTIFACT_FORMATS[key][locale].replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
}

/** Match only the complete generated suffix, never incidental Korean/English in a user name. */
export function editedPathLocale(path: string): Locale | undefined {
  for (const locale of ['ko', 'en'] as const) {
    for (const key of ['edited', 'editedNumbered'] as const) {
      const pattern = ARTIFACT_FORMATS[key][locale].split(/(\{\d+\})/).map(part =>
        part === '{0}' ? '.+' : part === '{1}' ? '\\d+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      if (new RegExp('^' + pattern + '$', 'i').test(path)) return locale;
    }
  }
  return undefined;
}
