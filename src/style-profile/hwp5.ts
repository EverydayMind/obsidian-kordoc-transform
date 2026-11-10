import { inflateRawSync } from 'node:zlib';
import type { StyleSnapshot } from './types';
import { readOle } from './ole';
import { Guard, LIMITS, StyleError } from './limits';
import { records } from './hwp5-records';
import { Hwp5Styles } from './hwp5-docinfo';
import { measureHwp5Sections } from './hwp5-sections';
import { Hwp5Numbering } from './hwp5-numbering';
import type { AutomaticMarker } from './numbering';
import type { PageNumberControls } from './page-number-controls';
import type { ScriptRuns } from './script-runs';

export async function extractHwp5(bytes: Uint8Array, source: StyleSnapshot['source'], guard: Guard) {
  const ole = await readOle(bytes, guard), header = ole.get('FileHeader');
  if (!header || header.length < 40 || header.subarray(0, 17).toString('ascii') !== 'HWP Document File') throw new StyleError('unsupported', 'HWP5 FileHeader required.');
  if (header[35] !== 5) throw new StyleError('unsupported', 'HWP version 5 required.');
  const flags = header.readUInt32LE(36);
  if (flags & 2) throw new StyleError('encrypted', 'Password protected HWP5.');
  if (flags & 16) throw new StyleError('drm', 'DRM protected HWP5.');
  if (flags & 4) throw new StyleError('unsupported', 'Distribution-protected HWP5 unsupported.');
  let total = 0;
  const decode = async (name: string) => {
    await guard.tick(); const raw = ole.get(name); if (!raw) throw new StyleError('corrupted', 'Missing HWP stream.');
    let data: Buffer;
    try { data = flags & 1 ? inflateRawSync(raw, { maxOutputLength: Math.min(LIMITS.stream, LIMITS.inflated - total) }) : raw; }
    catch { throw new StyleError('bomb', 'Invalid or oversized HWP compressed stream.'); }
    total += data.length; if (data.length > LIMITS.stream || total > LIMITS.inflated) throw new StyleError('bomb', 'HWP decompression limit.');
    return records(data, guard);
  };
  const info = await decode('DocInfo');
  const sectionNames = [...ole.keys()].filter(name => /^BodyText\/Section\d+$/.test(name)).sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]));
  if (!sectionNames.length || sectionNames.length > 256) throw new StyleError('corrupted', 'Invalid HWP section count.');
  const streams: Awaited<ReturnType<typeof records>>[] = []; for (const name of sectionNames) streams.push(await decode(name));
  const snapshot: StyleSnapshot = { schema: 'report-style-snapshot/1', extractorVersion: 'kordoc-style/1', source, complete: true, sections: [], nodes: [], characterStyles: [], paragraphStyles: [], paragraphs: [], tables: [], unsupported: [], warnings: [] };
  const automaticMarkers = new Map<string, AutomaticMarker>();
  const scriptRuns: ScriptRuns = new Map();
  const texts = await measureHwp5Sections(streams, new Hwp5Styles(info), snapshot, guard, new Hwp5Numbering(info), automaticMarkers, scriptRuns);
  const pageNumberControls: PageNumberControls = Object.fromEntries(snapshot.sections.map(section => [section.ref, { state: 'unknown', count: null }]));
  return { snapshot, texts, automaticMarkers, pageNumberControls, scriptRuns };
}
