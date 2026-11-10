import fs from 'node:fs';
import path from 'node:path';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const sections = [`# Third-party notices\n\nkordoc ${pkg.dependencies.kordoc}; bundled JavaScript and PDF.js assets.\n`];
sections.push('## PDF.js bundling modifications\n\nThe bundled PDF.js API/worker global exports and kordoc worker registration are redirected to a private module scope at build time. This preserves the host application PDF.js globals. Source transformation: scripts/isolate-pdfjs.mjs. Original PDF.js licensing is retained below.\n');
for (const file of ['NOTICE', ...fs.readdirSync('node_modules/kordoc/THIRD_PARTY').map(f => `THIRD_PARTY/${f}`)]) {
  sections.push(`## kordoc/${file}\n\n\`\`\`text\n${fs.readFileSync(path.join('node_modules/kordoc', file), 'utf8').trim()}\n\`\`\`\n`);
}
const visited = new Set();
function visit(name, parent = process.cwd()) {
  if (['onnxruntime-node', 'sharp', '@hyzyla/pdfium', '@huggingface/tokenizers'].includes(name) || name.startsWith('@img/')) return;
  let dir;
  for (let current = parent; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) { dir = candidate; break; }
    if (path.dirname(current) === current) return;
  }
  if (visited.has(dir)) return;
  visited.add(dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter(f => /^(licen[sc]e|copying|notice|third.?party)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
  sections.push(`## ${data.name} ${data.version}\n\nLicense: ${data.license ?? 'see package notices'}\n`);
  for (const file of files) sections.push(`### ${file}\n\n\`\`\`text\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n\`\`\`\n`);
  for (const dep of Object.keys(data.dependencies ?? {})) visit(dep, dir);
}
for (const name of ['kordoc', 'pdfjs-dist', '@xmldom/xmldom', 'cfb', 'jszip', '@modelcontextprotocol/sdk']) visit(name);
fs.writeFileSync('THIRD_PARTY_NOTICES.md', sections.join('\n'));
console.log(`Preserved notices for ${visited.size} runtime dependencies.`);
