import { createRequire } from "node:module";
import type * as Engine from "./engine-entry";
import type * as Runtime from "./style-profile/entry";
const load = createRequire(import.meta.url);
export function loadEngineEntry(): typeof Engine { return load("../runtime/engine.cjs") as typeof Engine; }
export function loadStyleProfileEntry(): typeof Runtime { return load("./style-profile/entry.ts") as typeof Runtime; }
