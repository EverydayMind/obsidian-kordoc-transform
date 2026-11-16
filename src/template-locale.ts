import { getLocale, type Locale } from './locale';
import { EMBEDDED_TEMPLATES } from './template-data';

const titles: Record<string,string> = {
  gian: 'Standard draft — Appendix Form 1 (external notices/cooperation letters, 23 click-here fields)',
  'gian-simple': 'Simple draft — Appendix Form 2 (internal approval reports/plans, approval table, 13 click-here fields)',
};
const samples: Record<string, readonly string[]> = {
  gian: ['Ministry of Example','See recipient list','','Request for cooperation on the 2026 administrative automation pilot',
    '1. Reference: Ministry of Example, Division-1234 (2026. 7. 20.)\n2. Our ministry requests cooperation on the following pilot project to improve administrative efficiency.\n  A. Project: Administrative document automation pilot\n  B. Period: 2026. 8. 1. ~ 12. 31.\n  C. Scope: Central and local government agencies',
    'Pilot project plan','Minister of Example','Heads of central government agencies','Administrative officer Alex Kim','Division head Morgan Lee','Director Jamie Park','','Division-5678','2026. 7. 26.','','','30112','13 Example Road, Sejong','www.example.go.kr','044-000-0000','044-000-0001','example@korea.kr','Public'],
  'gian-simple': ['Division-1234','2026. 7. 26.','2026. 7. 26.','Public','Officer','Division head','Director','Vice minister','Division head Alex Kim','2026 pilot project implementation plan report','Basis: Article 00 of the Example Act. The pilot project implementation plan is reported in the attachment.','2026. 7. 26.','Ministry of Example, Example Bureau'],
};
export function templateTitle(template: typeof EMBEDDED_TEMPLATES[number], locale: Locale = getLocale()): string {
  return locale === 'ko' ? template.title : titles[template.id];
}
/** Field keys are the actual Korean template labels required by the form filler. */
export function templateSample(template: typeof EMBEDDED_TEMPLATES[number], locale: Locale = getLocale()): Record<string,string> {
  if (locale === 'ko') return template.sample;
  const keys = Object.keys(template.sample), values = samples[template.id];
  if (!values || values.length !== keys.length) throw new Error('Embedded template sample fields changed; update the English sample.');
  return Object.fromEntries(keys.map((key,i)=>[key,values[i]]));
}
