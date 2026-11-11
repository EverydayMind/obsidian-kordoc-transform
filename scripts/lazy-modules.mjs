import { fileURLToPath } from "node:url";
export function lazyModules() {
  let count = 0;
  return { name: "lazy-modules", setup(build) {
    build.onStart(() => { count = 0; });
    build.onLoad({ filter: /[\\/]src[\\/]lazy-modules\.ts$/ }, () => {
      count++;
      return { contents: 'export const loadEngineEntry = () => require("./engine-entry.ts"); export const loadStyleProfileEntry = () => require("./style-profile/entry.ts");', loader: "js", resolveDir: fileURLToPath(new URL("../src", import.meta.url)) };
    });
    build.onEnd(result => { if (!result.errors.length && count !== 1) return { errors: [{ text: `Expected one lazy-modules replacement, got ${count}` }] }; });
  } };
}
