import fs from 'node:fs/promises';
import path from 'node:path';
import { transformPdfjs } from './dependency-shims.mjs';
import { gzipSync } from 'node:zlib';

export function isolatePdfjs({ workerNodeMode = false, expectedAssetModules = 1 } = {}) {
  const scope = path.resolve('src/pdfjs-scope.ts');
  const counts = { worker: 0, api: 0, registration: 0, nodeMode: 0, pdf: 0, pdfWorker: 0, assets: 0 };
  return {
    name: 'isolate-pdfjs-globals',
    setup(build) {
      build.onResolve({ filter: /^kordoc-embedded-pdf-assets$/ }, () => ({ path: 'assets', namespace: 'pdf-assets' }));
      build.onLoad({ filter: /.*/, namespace: 'pdf-assets' }, async () => {
        const root = path.dirname((await import('node:module')).createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
        const data = {};
        for (const dir of ['cmaps', 'standard_fonts']) {
          const names = (await fs.readdir(path.join(root, dir))).sort();
          for (const name of names) {
            if (dir === 'cmaps' && !name.endsWith('.bcmap')) continue;
            const file = path.join(root, dir, name);
            if ((await fs.stat(file)).isFile()) data[`${dir}/${name}`] = (await fs.readFile(file)).toString('base64');
          }
        }
        if (!data['cmaps/Adobe-Korea1-UCS2.bcmap'] || !data['standard_fonts/FoxitSerif.pfb']) throw new Error('PDF.js assets missing');
        // The gzip header records the build OS (byte 9); pin it to Unix so main.js is identical on every OS.
        const gzip = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
        gzip[9] = 3;
        const packed = gzip.toString('base64');
        return { loader: 'js', contents: `import { gunzipSync } from 'node:zlib';
let assets;
function read(key) { assets ??= JSON.parse(gunzipSync(Buffer.from(${JSON.stringify(packed)}, 'base64')).toString('utf8')); if (!Object.prototype.hasOwnProperty.call(assets, key)) throw new Error('Missing PDF asset: ' + key); return new Uint8Array(Buffer.from(assets[key], 'base64')); }
export class CMapReaderFactory { async fetch({name}) { return { cMapData: read('cmaps/' + name + '.bcmap'), isCompressed: true }; } }
export class StandardFontDataFactory { async fetch({filename}) { return read('standard_fonts/' + filename); } }
` };
      });
      build.onLoad({ filter: /(?:pdfjs-dist[\\/].*\.mjs|kordoc[\\/]dist[\\/].*\.js)$/ }, async ({ path: filename }) => {
        let contents = await fs.readFile(filename, 'utf8');
        let changed = false;
        if (/kordoc[\\/]dist[\\/]parser-[^\\/]+\.js$/.test(filename) && contents.includes('var pdfjsAssets = {};')) {
          const pattern = /var pdfjsAssets = \{\};\s*try \{\s*const _require = createRequire\(import\.meta\.url\);\s*const pkgDir = dirname\(_require\.resolve\("pdfjs-dist\/package\.json"\)\);\s*pdfjsAssets\.cMapUrl = join\(pkgDir, "cmaps"\) \+ "\/";\s*pdfjsAssets\.cMapPacked = true;\s*pdfjsAssets\.standardFontDataUrl = join\(pkgDir, "standard_fonts"\) \+ "\/";\s*\} catch \{\s*\}/g;
          const matches = [...contents.matchAll(pattern)];
          if (matches.length !== 1) throw new Error(`PDF asset lookup pattern changed: ${filename}`);
          contents = contents.replace(pattern, 'var pdfjsAssets = { CMapReaderFactory, StandardFontDataFactory, useWorkerFetch: false };');
          const statement = `import { CMapReaderFactory, StandardFontDataFactory } from 'kordoc-embedded-pdf-assets';\n`;
          contents = contents.startsWith('#!') ? contents.replace(/^(#![^\n]*\n)/, '$1' + statement) : statement + contents;
          counts.assets++;
          changed = true;
        }
        if (/[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf(?:\.worker)?\.mjs$/.test(filename)) {
          contents = transformPdfjs(contents, filename);
          counts[filename.endsWith('pdf.worker.mjs') ? 'pdfWorker' : 'pdf']++;
          changed = true;
        }
        const replace = (pattern, replacement, key) => {
          contents = contents.replace(pattern, () => { changed = true; counts[key]++; return replacement; });
        };
        replace(/globalThis\.pdfjsWorker/g, 'kordocPdfjsScope.pdfjsWorker', 'worker');
        replace(/globalThis\.pdfjsLib/g, 'kordocPdfjsScope.pdfjsLib', 'api');
        replace(/g\.pdfjsWorker = pdfjsWorker;/g, 'kordocPdfjsScope.pdfjsWorker = pdfjsWorker;', 'registration');
        if (workerNodeMode && /pdfjs-dist[\\/]/.test(filename)) {
          replace(/process\.versions\.electron\s*&&\s*process\.type\s*&&\s*process\.type\s*!==\s*["']browser["']/g, 'false', 'nodeMode');
        }
        if (!changed) return;
        const statement = `import { pdfjsScope as kordocPdfjsScope } from ${JSON.stringify(scope)};\n`;
        if (contents.startsWith('#!')) contents = contents.replace(/^(#![^\n]*\n)/, '$1' + statement);
        else contents = statement + contents;
        return { contents, loader: 'js', resolveDir: path.dirname(filename) };
      });
      build.onEnd(result => {
        if (!result.errors.length && counts.assets !== expectedAssetModules) return { errors: [{ text: `Expected ${expectedAssetModules} PDF asset lookups, found ${counts.assets}` }] };
        if (!result.errors.length && (counts.pdf !== 1 || counts.pdfWorker !== 1)) {
          return { errors: [{ text: `PDF.js dependency patterns changed: ${JSON.stringify(counts)}` }] };
        }
        if (!result.errors.length && (!counts.worker || !counts.api || !counts.registration)) {
          return { errors: [{ text: `PDF.js isolation patterns changed: ${JSON.stringify(counts)}` }] };
        }
        if (!result.errors.length && workerNodeMode && counts.nodeMode < 2) {
          return { errors: [{ text: `PDF.js worker environment patterns changed: ${JSON.stringify(counts)}` }] };
        }
      });
    },
  };
}
