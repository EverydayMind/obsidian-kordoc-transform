import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";

// The pack must match the bundled engine version; the plugin version may be a later patch.
import { VERSION } from "./engine-version";
import { setKordocModelDir } from "./model-dir";
declare const __KORDOC_RUNTIME_DIRECTORY__: string | undefined;
const HELP = "https://github.com/everydaymind/obsidian-kordoc-transform#ocr-add-on";
const required = ["engine.cjs", "parse-worker.cjs", "web-worker-engine.cjs", "models/manifest.json", "models/Pix2Text-LICENSE", "models/PaddleOCR-LICENSE", "node_modules/onnxruntime-node/package.json", "node_modules/sharp/package.json", "node_modules/@hyzyla/pdfium/package.json", "node_modules/@huggingface/tokenizers/package.json", "README.md", "THIRD_PARTY_NOTICES.md"];
let directory = typeof __KORDOC_RUNTIME_DIRECTORY__ === "string" ? __KORDOC_RUNTIME_DIRECTORY__ : "";
let verified: string | undefined;
let workerVerified = false;
let failure: string | undefined;
export function configureRuntimePaths(pluginDirectory: string): void {
  if (!isAbsolute(pluginDirectory)) throw new Error("Absolute plugin directory required.");
  directory = join(pluginDirectory, "runtime");
  verified = undefined; workerVerified = false; failure = undefined;
  setKordocModelDir(join(directory, "models"));
}
export function runtimePath(...parts: string[]): string { return join(directory, ...parts); }
function inspect(): { files: Record<string, string> } {
  if (!directory || !existsSync(runtimePath("pack.json"))) throw new Error("OCR 추가 팩이 설치되지 않았습니다.");
  let data: unknown;
  try { data = JSON.parse(readFileSync(runtimePath("pack.json"), "utf8")); }
  catch { throw new Error("OCR 추가 팩 정보를 읽을 수 없습니다."); }
  if (!data || typeof data !== "object" || !("format" in data) || data.format !== 1 || !("pluginId" in data) || data.pluginId !== "kordoc-transform" || !("pluginVersion" in data) || data.pluginVersion !== VERSION || !("engineVersion" in data) || data.engineVersion !== VERSION) throw new Error("OCR 추가 팩의 형식 또는 버전이 맞지 않습니다.");
  if (!("platform" in data) || data.platform !== process.platform || !("arch" in data) || data.arch !== process.arch) throw new Error("OCR 추가 팩의 운영체제 또는 아키텍처가 맞지 않습니다.");
  if (!("buildId" in data) || typeof data.buildId !== "string" || !/^[a-f0-9]{7,40}$/.test(data.buildId) || !("files" in data) || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) throw new Error("OCR 추가 팩의 파일 목록이 잘못되었습니다.");
  for (const name of required) if (!Object.prototype.hasOwnProperty.call(data.files, name) || !existsSync(runtimePath(...name.split("/")))) throw new Error(`OCR 추가 팩의 필수 파일이 없습니다: ${name}`);
  for (const name of Object.keys(data.files)) if (!existsSync(runtimePath(...name.split("/")))) throw new Error(`OCR 추가 팩 파일이 없습니다: ${name}`);
  return { files: data.files as Record<string, string> };
}
export function runtimePackError(verify: boolean | "worker" = false): string | undefined {
  if (failure) return failure;
  if (verify === "worker" && workerVerified || verify === true && verified) return undefined;
  try {
    const pack = inspect();
    if (verify && !(verify === "worker" ? workerVerified : verified)) {
      const entries = verify === "worker" ? ["engine.cjs", "parse-worker.cjs", "web-worker-engine.cjs"].map(name => [name, pack.files[name]] as const) : Object.entries(pack.files);
      for (const [name, expected] of entries) {
        const target = resolve(directory, name);
        if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || !target.startsWith(resolve(directory) + sep) || !/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(readFileSync(target)).digest("hex") !== expected) throw new Error(`OCR 추가 팩 파일이 손상되었습니다: ${name}`);
      }
      if (verify === "worker") workerVerified = true;
      else { verified = "ok"; workerVerified = true; }
    }
    return undefined;
  } catch (error) {
    failure = `${error instanceof Error ? error.message : String(error)} 설치 안내: ${HELP}`;
    return failure;
  }
}
export function hasRuntimePack(): boolean { return !runtimePackError(); }
export function requireRuntimePack(): void { const error = runtimePackError(true); if (error) throw new Error(error); }
export function requireWorkerPack(): void { const error = runtimePackError("worker"); if (error) throw new Error(error); }
export function runtimeRequire(name: string): unknown { requireRuntimePack(); return createRequire(runtimePath("loader.cjs"))(name); }
export function runtimeResolve(name: string): string { requireRuntimePack(); return createRequire(runtimePath("loader.cjs")).resolve(name); }
