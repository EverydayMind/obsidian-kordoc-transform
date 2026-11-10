import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const [manifest, pkg, versions] = await Promise.all(['manifest.json', 'package.json', 'versions.json'].map(async p => JSON.parse(await readFile(p, 'utf8'))));
if (manifest.id !== 'kordoc-transform' || pkg.name !== manifest.id || manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion || (process.argv[2] && process.argv[2] !== manifest.version)) throw new Error('Release metadata mismatch');
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = tracked.filter(p => /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)[^/]*(PLAN|REVIEW|HANDOFF)[^/]*\.md$|^(docs|tests|test|node_modules|artifacts|runtime)\/|^main\.js$|\.map$/i.test(p));
if (forbidden.length) throw new Error(`Forbidden tracked files: ${forbidden.join(', ')}`);
console.log('Release metadata and tracked-file checks passed.');
