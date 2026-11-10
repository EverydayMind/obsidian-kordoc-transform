import fs from 'node:fs/promises';

// JSZip 3.10.1 splits JavaScript strings at fixed UTF-16 boundaries before
// encoding. Preserve a surrogate pair that straddles one of those boundaries.
export function safeJsZipStrings() {
  let patched = false;
  const before = 'case "string":\n            data = this.data.substring(this.index, nextIndex);';
  const after = `case "string":
            if (nextIndex < this.max) {
                var high = this.data.charCodeAt(nextIndex - 1), low = this.data.charCodeAt(nextIndex);
                if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) nextIndex--;
            }
            data = this.data.substring(this.index, nextIndex);`;
  return {
    plugin: { name: 'safe-jszip-strings', setup(build) {
      build.onLoad({ filter: /[\\/]jszip[\\/]lib[\\/]stream[\\/]DataWorker\.js$/ }, async ({ path }) => {
        const source = await fs.readFile(path, 'utf8');
        if (source.split(before).length !== 2) throw new Error('Unexpected JSZip DataWorker; cannot safely patch string chunks');
        patched = true;
        return { contents: source.replace(before, after), loader: 'js' };
      });
    } },
    assertUsed() { if (!patched) throw new Error('JSZip string chunk patch was not included in the engine'); },
  };
}
