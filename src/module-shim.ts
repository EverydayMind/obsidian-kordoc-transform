/*
 * 폐쇄망 번들용 "module" 셰임.
 *
 * kordoc 은 OLE2/CFB 파싱(HWP5·구형 XLS)을 위해 cfb 를 다음과 같이 동적 로드한다:
 *     import { createRequire } from "module";
 *     const require2 = createRequire(import.meta.url);
 *     const CFB = require2("cfb");
 *
 * esbuild 는 이런 "동적" require(문자열이 require 호출에 직접 들어가지 않는 형태)를
 * 번들에 포함하지 못하고 런타임 require("cfb") 호출을 그대로 남긴다. 배포본은
 * main.js 단독(node_modules 없음)이라 런타임에 "Cannot find module 'cfb'" 로 실패한다.
 *
 * 해결: esbuild alias 로 "module" 을 이 파일로 바꾸고, cfb 를 정적 import 해 번들에
 * 포함시킨다. createRequire 가 돌려주는 require 함수가 "cfb" 요청을 받으면 번들된
 * 모듈을 반환하고, 그 외 모듈은 원래 node 의 require 로 위임한다.
 *
 * 주의: 이 파일은 alias 의 영향을 받지 않는 "node:module" 에서 원본을 가져온다
 * (alias 는 "module" 만 대상 → 무한 루프 회피).
 */
import * as nodeModule from "node:module";
import CFB from "cfb";

// require("...") 로 받을 수 있도록 번들된 모듈 테이블.
const bundled: Record<string, unknown> = {
  cfb: CFB,
};

const realCreateRequire = (nodeModule as unknown as typeof import("node:module"))
  .createRequire;

export function createRequire(filename: string | URL): NodeRequire {
  const real = realCreateRequire(filename);
  const patched = ((id: string) => {
    if (Object.prototype.hasOwnProperty.call(bundled, id)) {
      return bundled[id];
    }
    return real(id) as unknown;
  }) as NodeRequire;
  // resolve / cache / main 등 원본 require 의 속성 보존
  return Object.assign(patched, real) as NodeRequire;
}

// "module" 의 나머지 named export 들을 그대로 재노출 (다른 코드가 쓸 수 있으므로).
const nm = nodeModule as unknown as Record<string, unknown>;
export const Module = nm.Module;
export const builtinModules = nm.builtinModules;
export const isBuiltin = nm.isBuiltin;
export const syncBuiltinESMExports = nm.syncBuiltinESMExports;
export const findSourceMap = nm.findSourceMap;
export const SourceMap = nm.SourceMap;
export const register = nm.register;

export default (nm.default ?? nodeModule);
