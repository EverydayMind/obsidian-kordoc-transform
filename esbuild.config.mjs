import esbuild from "esbuild";
import { lazyModules } from "./scripts/lazy-modules.mjs";
import process from "process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "url";
import { VERSION } from "kordoc";
import { dependencyShimsPlugin } from "./scripts/dependency-shims.mjs";
import { isolatePdfjs } from "./scripts/isolate-pdfjs.mjs";
import { safeJsZipStrings } from "./scripts/safe-jszip-strings.mjs";
import { readFileSync } from "node:fs";

const production = process.argv[2] === "production";
const zip = safeJsZipStrings();
const nativeLoader = {
  name: "runtime-native-loader",
  setup(build) {
    build.onResolve({ filter: /^(sharp|onnxruntime-node|@huggingface\/tokenizers)$/ }, args => ({ path: args.path, namespace: "runtime-native" }));
    build.onLoad({ filter: /.*/, namespace: "runtime-native" }, args => ({
      contents: `const { runtimeRequire } = require("./src/runtime-paths.ts"); module.exports = runtimeRequire(${JSON.stringify(args.path)});`,
      resolveDir: process.cwd(),
      loader: "js",
    }));
  },
};

// "module" 셰임 경로 (cfb 동적 require 를 번들에 포함시키기 위함 — module-shim.ts 참고).
const moduleShim = fileURLToPath(new URL("./src/module-shim.ts", import.meta.url));

const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8").replaceAll("*/", "* /");
const banner = `/*!\n${notices}\n*/\n/*
KorDoc 문서 변환기 — kordoc ${VERSION} 기반 Obsidian 플러그인.
이 파일은 esbuild로 번들된 결과물입니다. 직접 수정하지 마세요. (src/main.ts 수정 후 빌드)
*/
// CJS 로 로드되는 환경에서 ESM 의 import.meta.url 을 main.js 경로 기반 file URL 로 shim.
const import_meta_url = require('url').pathToFileURL(__filename).href;
`;

/**
 * external 처리 대상.
 * - obsidian / electron / Node 빌트인: Obsidian 런타임이 제공.
 * 엔진과 pdfjs는 scripts/build-runtime.mjs에서 runtime/engine.cjs로 빌드한다.
 * 네이티브 OCR 라이브러리는 runtime/node_modules에 보존하며 첫 OCR 때 로드한다.
 */
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  // 엔진 의존성이 시작 번들에 들어오지 않도록 유지한다.
  "canvas",
  "@huggingface/transformers",
  "puppeteer-core",
  "zxing-wasm/reader",
  ...builtinModules,
];

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2020",
  platform: "node",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  plugins: [lazyModules(), nativeLoader, dependencyShimsPlugin({ mcpValidator: 1 }), zip.plugin, isolatePdfjs({ expectedAssetModules: 2 })],
  minify: production,
  outfile: "main.js",
  banner: { js: banner },
  // kordoc 이 createRequire(import.meta.url)("cfb") 로 cfb 를 동적 로드한다.
  // "module" import 를 셰임으로 바꿔 cfb 를 번들에 정적 포함시킨다.
  alias: {
    module: moduleShim,
    "@hyzyla/pdfium": fileURLToPath(new URL("./src/pdfium-shim.ts", import.meta.url)),
  },
  // pdfjs-dist 등 ESM .mjs 를 CJS 로 인터롭
  mainFields: ["module", "main"],
  conditions: ["import", "node", "default"],
  inject: ["src/model-dir.ts"],
  define: {
    "__KORDOC_RUNTIME_DIRECTORY__": "undefined",
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
    // kordoc/pdfjs 가 ESM 의 import.meta.url 로 createRequire 를 호출한다.
    // Obsidian 은 main.js 를 CJS 로 로드하므로 import.meta.url 이 비어 크래시.
    // __filename(=main.js 경로) 기반 file URL 로 shim 한다.
    "import.meta.url": "import_meta_url",
    "process.env.KORDOC_MODEL_CACHE": "kordocModelDir",
    "process.env.KORDOC_OFFLINE": '"1"',
  },
});

if (production) {
  await ctx.rebuild();
  zip.assertUsed();
  await ctx.dispose();
  console.log("✅ production build 완료 → main.js");
} else {
  await ctx.watch();
  console.log("👀 watch 모드 — src 변경 감지 중");
}
