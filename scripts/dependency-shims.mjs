import { readFile } from 'node:fs/promises';

// Called by the PDF isolation onLoad hook, which owns these same input files.
export function transformPdfjs(contents, filename) {
  const changes = [
    ['function isEvalSupported() {\n  try {\n    new Function("");\n    return true;\n  } catch {\n    return false;\n  }\n}', 'function isEvalSupported() { return false; }'],
    ["return Function('return require(\"' + name + '\")')();", 'return typeof process.getBuiltinModule === "function" ? process.getBuiltinModule(name) : require(name);'],
    ["(function () { return this; })() || Function('return this')()", 'globalThis'],
  ];
  if (filename.endsWith('pdf.worker.mjs')) changes.push([
    'if (isEvalSupported && FeatureTest.isEvalSupported) {\n      const compiled = new PostScriptCompiler().compile(code, domain, range);\n      if (compiled) {\n        return new Function("src", "srcOffset", "dest", "destOffset", compiled);\n      }\n    }',
    '/* Always use the interpreter, as when isEvalSupported is false. */',
  ]);
  for (const [pattern, replacement] of changes) {
    const count = contents.split(pattern).length - 1;
    if (count !== 1) throw new Error(`${filename}: expected one PDF.js pattern, found ${count}: ${pattern.slice(0, 50)}`);
    contents = contents.replace(pattern, replacement);
  }
  return contents;
}

// The desktop host provides setImmediate. Keep a timer fallback for other hosts.
// Reject unexpected upstream source changes instead of silently dropping the shim.
export function dependencyShimsPlugin({ setimmediate = 1, immediate = 1, mcpValidator = 0 } = {}) {
  const counts = { immediate: 0, setimmediate: 0, mcpValidator: 0 };
  const shims = [
    { key: 'immediate', filter: /[\\/]immediate[\\/]lib[\\/]index\.js$/,
      patterns: ["global.document.createElement('script')", 'module.exports = immediate;'],
      contents: 'module.exports = function immediate(task) { queueMicrotask(task); };\n' },
    { key: 'setimmediate', filter: /[\\/]setimmediate[\\/]setImmediate\.js$/,
      patterns: ['callback = new Function("" + callback);', 'function installReadyStateChangeImplementation()'],
      contents: "if (typeof globalThis.setImmediate !== 'function') { globalThis.setImmediate = function (callback, ...args) { return setTimeout(callback, 0, ...args); }; globalThis.clearImmediate = clearTimeout; }\n" },
  ];
  return { name: 'dependency-shims', setup(build) {
    for (const shim of shims) build.onLoad({ filter: shim.filter }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      for (const pattern of shim.patterns) {
        const count = source.split(pattern).length - 1;
        const expected = shim.key === 'immediate' && pattern.includes('createElement') ? 2 : 1;
        if (count !== expected) throw new Error(`${shim.key}: expected ${expected} occurrences of ${pattern}, found ${count}`);
      }
      counts[shim.key]++;
      return { contents: shim.contents, loader: 'js' };
    });
    build.onLoad({ filter: /[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/]validation[\\/]ajv-provider\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      for (const pattern of ["import Ajv from 'ajv';", 'this._ajv = ajv ?? createDefaultAjvInstance();']) {
        if (source.split(pattern).length !== 2) throw new Error(`MCP validator pattern changed: ${pattern}`);
      }
      counts.mcpValidator++;
      // The local server never calls elicitInput; fail closed if that changes.
      return { contents: "export class AjvJsonSchemaValidator { getValidator() { throw new Error('MCP elicitation validation is unavailable'); } }\n", loader: 'js' };
    });
    build.onEnd(() => {
      const expected = { setimmediate, immediate, mcpValidator };
      const errors = Object.entries(counts).filter(([name, count]) => count !== expected[name])
        .map(([name, count]) => ({ text: `${name}: expected ${expected[name]} modules, found ${count}` }));
      return { errors };
    });
  } };
}
