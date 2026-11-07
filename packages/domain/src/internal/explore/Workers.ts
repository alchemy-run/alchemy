/**
 * The worker pool, on `node:worker_threads` (Bun and Node): bounded messages,
 * error, exit and timeout paths, and a config fingerprint the coordinator
 * checks.
 */
import { parentPort, Worker } from "node:worker_threads";
import { build, type Scenario } from "./Engine.ts";
import { EngineFault } from "./Errors.ts";
import { Expander, type ExpandItem, type ExpandOut } from "./Expand.ts";
import { swarmSeed, type Pool, type SwarmLimits, type SwarmOptions } from "./Search.ts";
import { fingerprintOf } from "./Trace.ts";

/** The part of `node:worker_threads` `Worker` the pool uses. */
export interface WorkerLike {
  on(event: "message" | "error" | "messageerror" | "exit", f: (value: any) => void): unknown;
  postMessage(m: unknown): void;
  terminate(): unknown;
}

export interface WorkerSpec {
  readonly count: number;
  /** The worker module: it calls `serveWorker(init => scenario)`. */
  readonly url: string | URL;
  /** Plain data the worker builds its scenario from. */
  readonly init: unknown;
  readonly timeoutMillis?: number;
  /** The worker class (default: `Worker` of `node:worker_threads`). */
  readonly worker?: new (url: string | URL) => WorkerLike;
}

export interface WorkerOptions {
  readonly exact: boolean;
  readonly k: number;
  readonly maxDepth: number;
}

type Reply =
  | { readonly t: "ready"; readonly fingerprint: string }
  | { readonly t: "done"; readonly id: number; readonly out: unknown }
  | { readonly t: "error"; readonly id?: number; readonly error: string };

type Waiter = { resolve: (w: WorkerLike) => void; reject: (e: unknown) => void };

export const startPool = async (
  spec: WorkerSpec,
  opts: WorkerOptions,
  fingerprint: string,
): Promise<Pool & { swarm: (seed: number, o: SwarmOptions, l: SwarmLimits) => Promise<any> }> => {
  const timeout = spec.timeoutMillis ?? 600_000;
  const Ctor: new (url: string | URL) => WorkerLike = spec.worker ?? Worker;
  const url =
    typeof spec.url === "string" && spec.url.startsWith("file:") ? new URL(spec.url) : spec.url;
  const workers = Array.from({ length: spec.count }, () => new Ctor(url));
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let failed: Error | undefined;
  const idle: Array<WorkerLike> = [];
  const waiters: Array<Waiter> = [];
  const failAll = (e: Error) => {
    failed ??= e;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
    for (const w of waiters.splice(0)) w.reject(e);
  };
  let nextId = 1;
  const release = (w: WorkerLike) => {
    const next = waiters.shift();
    if (next) next.resolve(w);
    else idle.push(w);
  };
  const acquire = () =>
    new Promise<WorkerLike>((resolve, reject) =>
      idle.length > 0 ? resolve(idle.pop()!) : waiters.push({ resolve, reject }),
    );
  const stop = () => {
    for (const w of workers) w.terminate();
  };

  try {
    await Promise.all(
      workers.map(
        (w, i) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new EngineFault("Worker", `worker ${i} init timed out`)),
              timeout,
            );
            w.on("error", (e) => {
              clearTimeout(timer);
              const err = new EngineFault("Worker", `worker ${i}: ${e?.message ?? e}`);
              reject(err);
              failAll(err);
            });
            w.on("exit", () => {
              clearTimeout(timer);
              const err = new EngineFault("Worker", `worker ${i} exited`);
              reject(err);
              failAll(err);
            });
            w.on("messageerror", () =>
              failAll(new EngineFault("Worker", `worker ${i}: a message could not be read`)),
            );
            w.on("message", (m: Reply) => {
              if (m?.t === "ready") {
                clearTimeout(timer);
                if (m.fingerprint !== fingerprint)
                  reject(
                    new EngineFault(
                      "Worker",
                      `worker ${i} runs another config (fingerprint ${m.fingerprint}, coordinator ${fingerprint})`,
                    ),
                  );
                else resolve();
                return;
              }
              if (m?.t === "error" && m.id === undefined) {
                clearTimeout(timer);
                reject(new EngineFault("Worker", `worker ${i} init: ${m.error}`));
                return;
              }
              if (!m || (m.t !== "done" && m.t !== "error") || typeof m.id !== "number") {
                failAll(new EngineFault("Worker", `worker ${i}: a malformed reply`));
                return;
              }
              const p = pending.get(m.id);
              if (!p) return;
              pending.delete(m.id);
              clearTimeout(p.timer);
              release(w);
              if (m.t === "error") p.reject(new EngineFault("Worker", m.error));
              else p.resolve(m.out);
            });
            w.postMessage({ t: "init", init: spec.init, opts });
          }),
      ),
    );
  } catch (e) {
    stop();
    throw e;
  }
  idle.push(...workers);

  const call = async (msg: Record<string, unknown>): Promise<any> => {
    if (failed) throw failed;
    const w = await acquire();
    if (failed) throw failed;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        failAll(new EngineFault("Worker", `a worker call timed out after ${timeout} ms`));
        reject(failed);
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      w.postMessage({ ...msg, id });
    });
  };

  return {
    size: spec.count,
    expand: (items: Array<ExpandItem>, bases: Map<number, Uint8Array>, skip: Array<string>) =>
      call({ t: "expand", items, bases: [...bases.entries()], skip }) as Promise<Array<ExpandOut>>,
    swarm: (seed: number, o: SwarmOptions, l: SwarmLimits) => call({ t: "swarm", seed, o, l }),
    stop,
  };
};

/** The worker side: build the scenario once, then expand what it is sent. */
export const serveWorker = (scenarioOf: (init: any) => Scenario) => {
  const port = parentPort;
  if (!port) throw new EngineFault("Worker", "serveWorker runs only inside a worker");
  let expander: Expander | undefined;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  port.on("message", async (m: any) => {
    try {
      if (m.t === "init") {
        const scenario = scenarioOf(m.init);
        built = await build(scenario);
        expander = new Expander(built, {
          exact: m.opts.exact,
          k: m.opts.k,
          maxDepth: m.opts.maxDepth,
        });
        port.postMessage({ t: "ready", fingerprint: fingerprintOf(scenario) });
        return;
      }
      if (m.t === "expand") {
        const out = expander!.expand(m.items, new Map(m.bases), new Set(m.skip));
        port.postMessage({ t: "done", id: m.id, out });
        return;
      }
      if (m.t === "swarm") {
        port.postMessage({ t: "done", id: m.id, out: swarmSeed(built!, m.seed, m.o, m.l) });
        return;
      }
      port.postMessage({ t: "error", id: m.id, error: `unknown message ${m.t}` });
    } catch (err) {
      port.postMessage({
        t: "error",
        id: m.t === "init" ? undefined : m.id,
        error: String((err as Error)?.stack ?? err),
      });
    }
  });
};
