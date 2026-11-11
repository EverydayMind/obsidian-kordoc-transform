import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Worker as NodeWorker } from "node:worker_threads";

/** Experimental adapter. The normal pool does not select it by default. */
export class BrowserParseWorker {
  private readonly worker: Worker;
  private readonly url: string;
  private ready = false;
  private terminated = false;
  private pending?: { value: unknown; transfer: ArrayBuffer[] };
  private messageHandler?: (value: unknown) => void;
  private errorHandler?: (error: Error) => void;
  private readonly startupTimer: number;

  constructor(workerFile: string, startupTimeoutMs = 10_000) {
    const source = readFileSync(workerFile, "utf8");
    const engineFile = join(dirname(workerFile), "web-worker-engine.cjs");
    // Module paths are local installed artifacts, encoded as JS string literals.
    const bridge = `const nativeRequire = require; require = (name) => name === 'node:worker_threads' ? { parentPort: { on: (event, fn) => { if (event === 'message') self.addEventListener('message', e => fn(e.data)); }, postMessage: value => self.postMessage(value) } } : name === './engine.cjs' ? nativeRequire(${JSON.stringify(engineFile)}) : nativeRequire(name);\n`;
    this.url = URL.createObjectURL(new Blob([bridge, source, "\n;self.postMessage({__kordocWorkerReady:true});"], { type: "text/javascript" }));
    try {
      this.worker = new Worker(this.url);
    } catch (error) {
      URL.revokeObjectURL(this.url);
      throw error;
    }
    this.startupTimer = window.setTimeout(() => this.fail(new Error("변환 워커 준비 시간이 초과되었습니다.")), startupTimeoutMs);
    this.worker.onmessage = (event) => {
      if (this.terminated) return;
      const data: unknown = event.data;
      if (data && typeof data === "object" && "__kordocWorkerReady" in data && data.__kordocWorkerReady === true && !this.ready) {
        this.ready = true;
        window.clearTimeout(this.startupTimer);
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
          try { this.worker.postMessage(pending.value, pending.transfer); }
          catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        }
        return;
      }
      this.messageHandler?.(event.data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "변환 워커 오류"));
    };
    this.worker.onmessageerror = () => this.fail(new Error("변환 워커 메시지 오류"));
  }

  get startupPending(): boolean { return !this.ready; }
  on(event: "message", callback: (value: unknown) => void): this;
  on(event: "error", callback: (error: Error) => void): this;
  on(event: "message" | "error", callback: ((value: unknown) => void) | ((error: Error) => void)): this {
    if (event === "message") this.messageHandler = callback;
    if (event === "error") this.errorHandler = callback;
    return this;
  }
  postMessage(value: unknown, transfer: ArrayBuffer[]): void {
    if (this.terminated) throw new Error("변환 워커가 종료되었습니다.");
    if (!this.ready) {
      if (this.pending) throw new Error("변환 워커의 이전 요청이 대기 중입니다.");
      this.pending = { value, transfer };
      return;
    }
    this.worker.postMessage(value, transfer);
  }
  async terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      window.clearTimeout(this.startupTimer);
      this.pending = undefined;
      this.worker.terminate();
      URL.revokeObjectURL(this.url);
    }
    return 0;
  }
  private fail(error: Error): void {
    if (!this.terminated) this.errorHandler?.(error);
  }
}

/** Opt-in factory for callers that have independently accepted the Web Worker path. */
export function createBrowserParseWorker(workerFile: string): NodeWorker {
  return new BrowserParseWorker(workerFile) as unknown as NodeWorker;
}
