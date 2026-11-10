import { readFile } from 'node:fs/promises';

const patterns = [
  ['eval', /(?<![\w$.])eval\s*\(/g],
  ['Function constructor', /(?<![\w$.])(?:new\s+)?Function\s*\(/g],
  ['script element', /createElement\s*\(\s*["'`]script["'`]\s*\)/g],
];
if (process.argv.length < 3) throw new Error('Supply at least one bundle path');
let count = 0;
for (const file of process.argv.slice(2)) {
  const source = await readFile(file, 'utf8');
  for (const [label, pattern] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      console.error(`${file}:${line}: ${label}`);
      count++;
    }
  }
  console.log(`${file}: checked`);
}
console.log(`Forbidden patterns: ${count}`);
if (count) process.exitCode = 1;
