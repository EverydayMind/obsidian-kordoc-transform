// Electron renderer Web Workers can use require, but Node's dynamic import
// loader may crash their renderer. Keep these optional modules lazy and local.
const modules = new Set(['onnxruntime-node', 'sharp', '@huggingface/tokenizers', 'fs/promises']);

export function workerLazyNative() {
  const counts = new Map([...modules].map(name => [name, 0]));
  return {
    name: 'worker-lazy-native',
    setup(build) {
      build.onResolve({ filter: /^(?:onnxruntime-node|sharp|@huggingface\/tokenizers|fs\/promises)$/ }, args => {
        if (args.kind !== 'dynamic-import') return;
        counts.set(args.path, counts.get(args.path) + 1);
        return { path: args.path, namespace: 'worker-lazy-native' };
      });
      build.onLoad({ filter: /.*/, namespace: 'worker-lazy-native' }, args => ({
        contents: `module.exports = require(${JSON.stringify(args.path)});`,
        loader: 'js',
      }));
      build.onEnd(result => {
        if (!result.errors.length && [...counts.values()].some(count => count === 0)) {
          return { errors: [{ text: `Worker native import patterns changed: ${JSON.stringify(Object.fromEntries(counts))}` }] };
        }
      });
    },
  };
}
