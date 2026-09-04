/**
 * Main-thread client for the ELK Web Worker.
 *
 * - One lazily-spawned worker per page; requests are correlated by id.
 * - Requests are deduped by structural hash while in flight — layout is a
 *   deterministic function of the structure, so a late response is never
 *   wrong, just a cache warmer for its own hash.
 * - If the worker can't be constructed (or crashes), layout falls back to
 *   running elkjs on the main thread so the canvas still renders.
 */
import type { XY } from "../store.ts";
import {
  positionsOf,
  repackComponents,
  toElkGraph,
  type LayoutEdgeInput,
  type LayoutRequestMessage,
  type LayoutResponseMessage,
} from "./elkGraph.ts";

interface Waiter {
  resolve: (positions: Map<string, XY>) => void;
  reject: (error: unknown) => void;
}

/** undefined = not spawned yet; null = spawn failed → main-thread fallback */
let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Waiter>();
const inFlight = new Map<string, Promise<Map<string, XY>>>();

const toPositionMap = (
  positions: readonly [string, number, number][],
): Map<string, XY> => {
  const map = new Map<string, XY>();
  for (const [fqn, x, y] of positions) {
    map.set(fqn, { x, y });
  }
  return map;
};

const spawnWorker = (): Worker | null => {
  try {
    const spawned = new Worker(new URL("./elk.worker.ts", import.meta.url), {
      type: "module",
    });
    spawned.onmessage = (event: MessageEvent<LayoutResponseMessage>) => {
      const waiter = pending.get(event.data.id);
      if (waiter === undefined) {
        return;
      }
      pending.delete(event.data.id);
      if (event.data.ok && event.data.positions !== undefined) {
        waiter.resolve(toPositionMap(event.data.positions));
      } else {
        waiter.reject(new Error(event.data.error ?? "elk layout failed"));
      }
    };
    spawned.onerror = () => {
      // worker script failed to load or crashed — reject everything queued
      // (callers fall back to the main thread) and stop using it
      for (const waiter of pending.values()) {
        waiter.reject(new Error("elk worker crashed"));
      }
      pending.clear();
      spawned.terminate();
      worker = null;
    };
    return spawned;
  } catch {
    return null;
  }
};

const workerLayout = (
  target: Worker,
  fqns: readonly string[],
  edges: readonly LayoutEdgeInput[],
  aspectRatio: number,
): Promise<Map<string, XY>> =>
  new Promise<Map<string, XY>>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const message: LayoutRequestMessage = { id, fqns, edges, aspectRatio };
    target.postMessage(message);
  });

const mainThreadLayout = (
  fqns: readonly string[],
  edges: readonly LayoutEdgeInput[],
  aspectRatio: number,
): Promise<Map<string, XY>> =>
  import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) =>
    new ELK()
      .layout(toElkGraph(fqns, edges, aspectRatio))
      .then((root) =>
        toPositionMap(repackComponents(positionsOf(root), edges, aspectRatio)),
      ),
  );

/**
 * Run ELK for one structural hash. Deduped while in flight; off the main
 * thread whenever a Web Worker is available.
 */
export const requestLayout = (
  hash: string,
  fqns: readonly string[],
  edges: readonly LayoutEdgeInput[],
): Promise<Map<string, XY>> => {
  const existing = inFlight.get(hash);
  if (existing !== undefined) {
    return existing;
  }
  if (worker === undefined) {
    worker = spawnWorker();
  }
  // component packing targets the screen the user is actually looking at
  const aspectRatio =
    typeof window !== "undefined" && window.innerHeight > 0
      ? window.innerWidth / window.innerHeight
      : 1.8;
  const run =
    worker === null
      ? mainThreadLayout(fqns, edges, aspectRatio)
      : workerLayout(worker, fqns, edges, aspectRatio).catch(() =>
          mainThreadLayout(fqns, edges, aspectRatio),
        );
  const request = run.finally(() => inFlight.delete(hash));
  inFlight.set(hash, request);
  return request;
};
