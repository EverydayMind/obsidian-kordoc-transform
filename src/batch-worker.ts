import { Worker } from "node:worker_threads";
import { parse, type ParseOptions, type ParseResult } from "./engine";
import { workerPath } from "./engine";
import { guardZipInput } from "./zip-input-guard";
import { BrowserParseWorker } from "./browser-parse-worker";
import { hasRuntimePack, requireRuntimePack, requireWorkerPack } from "./runtime-paths";

interface Job {
  id: number; buffer: ArrayBuffer; options: ParseOptions;
  resolve: (result: ParseResult) => void; reject: (error: Error) => void;
  progress?: (current: number, total: number) => void;
}
interface Slot { worker: Worker; job?: Job; }

/** Use CPU workers where supported, with a serial fallback for Electron renderers. */
export class ParseWorkerPool {
  get usesRendererFallback(): boolean { return this.workersUnavailable; }
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 0;
  private closed = false;
  private readonly abort = new AbortController();
  private workersUnavailable: boolean;
  private fallbackJob?: Job;
  constructor(
    private readonly concurrency = 1,
    private readonly createWorker = () => new Worker(workerPath()),
    private readonly packAvailable: () => boolean = hasRuntimePack,
  ) { this.workersUnavailable = !this.packAvailable(); }

  parse(buffer: ArrayBuffer, options: ParseOptions = {}, progress?: Job["progress"]): Promise<ParseResult> {
    if (this.closed) return Promise.reject(new Error("변환 워커가 종료되었습니다."));
    if (options.ocr || options.formulaOcr || !this.workersUnavailable) {
      try {
        if (this.packAvailable === hasRuntimePack) {
          if (options.ocr || options.formulaOcr) requireRuntimePack();
          else requireWorkerPack();
        } else if (!this.packAvailable()) throw new Error("OCR 추가 팩이 설치되지 않았습니다.");
      }
      catch (error) {
        this.workersUnavailable = true;
        if (options.ocr || options.formulaOcr) return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, buffer: buffer.slice(0), options, progress, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    this.closed = true;
    this.abort.abort();
    const error = new Error("플러그인이 종료되어 변환을 중단했습니다.");
    for (const job of this.queue.splice(0)) job.reject(error);
    this.fallbackJob?.reject(error);
    for (const slot of this.slots.splice(0)) {
      slot.job?.reject(error);
      void slot.worker.terminate();
    }
  }

  private pump(): void {
    if (this.closed) return;
    const desired = Math.min(Math.max(1, Math.min(4, this.concurrency)), this.queue.length + this.slots.filter((s) => s.job).length);
    while (!this.workersUnavailable && this.slots.length < desired) {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch {
        // Electron can expose worker_threads while its V8 platform rejects
        // Worker construction. Keep the queued buffers for the local parser.
        this.workersUnavailable = true;
        break;
      }
      const slot: Slot = { worker };
      this.slots.push(slot);
      slot.worker.on("message", (message: unknown) => {
        const job = slot.job;
        if (!message || typeof message !== "object" || !("id" in message)) return;
        if (!job || message.id !== job.id) return;
        if ("progress" in message && Array.isArray(message.progress) && typeof message.progress[0] === "number" && typeof message.progress[1] === "number") { job.progress?.(message.progress[0], message.progress[1]); return; }
        slot.job = undefined;
        if ("error" in message && typeof message.error === "string" && message.error) job.reject(new Error(message.error));
        else if ("result" in message) job.resolve(message.result as ParseResult);
        else job.reject(new Error("Invalid worker response"));
        this.pump();
      });
      const fail = (error: Error) => {
        const index = this.slots.indexOf(slot);
        if (index < 0) return;
        this.slots.splice(index, 1);
        if (slot.worker instanceof BrowserParseWorker && slot.worker.startupPending) {
          // No transfer has happened before the ready signal, so the original
          // queued copy can safely enter the existing sequential fallback.
          this.workersUnavailable = true;
          if (slot.job) this.queue.unshift(slot.job);
        } else slot.job?.reject(error);
        void slot.worker.terminate();
        this.pump();
      };
      slot.worker.on("error", fail);
      slot.worker.on("exit", (code) => fail(new Error(`변환 워커 종료 (${code})`)));
    }
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      let options = job.options;
      if (slot.worker instanceof BrowserParseWorker) {
        try {
          // Snapshot before the asynchronous ready signal and detect options
          // such as a custom OCR callback that cannot cross a Worker boundary.
          options = structuredClone(options);
        } catch {
          this.queue.unshift(job);
          this.workersUnavailable = true;
          break;
        }
      }
      slot.job = job;
      const { id, buffer } = job;
      try {
        slot.worker.postMessage({ id, buffer, options }, [buffer]);
      } catch (error) {
        // A failed transfer must not leave the slot permanently occupied.
        // Its delivery state is unknown, so reject rather than retry the job.
        slot.job = undefined;
        this.slots.splice(this.slots.indexOf(slot), 1);
        job.reject(error instanceof Error ? error : new Error(String(error)));
        void slot.worker.terminate().catch(() => undefined);
        // Removing a slot while iterating may skip another idle slot.
        queueMicrotask(() => this.pump());
      }
    }
    if (this.workersUnavailable) {
      for (const slot of [...this.slots]) {
        if (slot.job) continue;
        this.slots.splice(this.slots.indexOf(slot), 1);
        void slot.worker.terminate();
      }
    }
    if (this.workersUnavailable && this.slots.length === 0 && !this.fallbackJob && this.queue.length) {
      const job = this.fallbackJob = this.queue.shift()!;
      void this.parseLocally(job);
    }
  }

  private async parseLocally(job: Job): Promise<void> {
    try {
      // Give notices and cancellation a turn before starting each document.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (this.closed) return;
      await guardZipInput(job.buffer, this.abort.signal);
      if (this.closed) return;
      const result = await parse(job.buffer, {
        ...job.options, ocr: job.options.ocr ?? false, formulaOcr: job.options.formulaOcr ?? false, filePath: undefined,
        onProgress: (current, total) => {
          if (!this.closed) job.progress?.(current, total);
        },
      });
      if (!this.closed) job.resolve(result);
    } catch (error) {
      if (!this.closed) job.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.fallbackJob = undefined;
      this.pump();
    }
  }
}
