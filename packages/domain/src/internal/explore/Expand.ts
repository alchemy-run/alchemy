/**
 * Expansion of frontier nodes, the same code in the coordinator and in a
 * worker. A node carries no world: it names a checkpoint
 * world (every `k` levels, deflate-compressed) and the moves from there; the
 * expander rebuilds it by replay, with a cache of recent worlds by step index.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { Digest } from "./Canonical.ts";
import {
  canonOf,
  checkRules,
  enabled,
  runAll,
  runOnce,
  stepOf,
  witnessesOf,
  type Built,
} from "./Engine.ts";
import { EngineFault, type EngineError } from "./Errors.ts";
import type { ScriptEntry, World } from "./Host.ts";

export interface ChainLink {
  readonly idx: number;
  readonly move: string;
  readonly script: ReadonlyArray<ScriptEntry>;
}

export interface ExpandItem {
  readonly idx: number;
  readonly depth: number;
  /** The checkpoint ancestor (its world is in `bases`). */
  readonly base: number;
  readonly chain: ReadonlyArray<ChainLink>;
}

export interface ChildOut {
  readonly move: string;
  readonly script: Array<ScriptEntry>;
  readonly digest: Digest;
  /** The canonical text (exact identity mode only). */
  readonly text?: string;
  readonly viol: Array<[string, string]>;
  /** Rules whose trigger this child witnessed. */
  readonly witnessed: Array<string>;
  readonly hasMoves: boolean;
  /** The child's world, compressed, when the child is a checkpoint. */
  readonly world?: Uint8Array;
}

export interface ExpandOut {
  readonly idx: number;
  readonly runs: number;
  readonly children: Array<ChildOut>;
  readonly engine: Array<EngineError>;
}

export interface ExpandOptions {
  readonly exact: boolean;
  /** Checkpoint every k levels. */
  readonly k: number;
  /** Children at this depth report whether they still have moves (WithinDepth). */
  readonly maxDepth: number;
}

export const pack = (w: World): Uint8Array => deflateSync(JSON.stringify(w));
export const unpack = (bytes: Uint8Array): World => JSON.parse(inflateSync(bytes).toString());

/** Rebuild a world: a checkpoint, then the scripted moves after it. */
export const replayChain = (
  b: Built,
  start: World,
  chain: ReadonlyArray<{ readonly move: string; readonly script: ReadonlyArray<ScriptEntry> }>,
) => {
  let w = start;
  for (const link of chain) {
    const move = enabled(b, w).find((m) => m.key === link.move);
    if (!move) throw new EngineFault("ReplayDiverged", `${link.move} is not enabled on replay`);
    const leaf = runOnce(b, w, move, link.script);
    if (leaf.engine.length > 0) throw new EngineFault(leaf.engine[0]!.kind, leaf.engine[0]!.detail);
    w = leaf.world;
  }
  return w;
};

class Lru<V> {
  private readonly map = new Map<number, V>();
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  get(k: number) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: number, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
  }
}

export class Expander {
  private readonly worlds = new Lru<string>(4096);
  readonly b: Built;
  readonly opts: ExpandOptions;

  constructor(b: Built, opts: ExpandOptions) {
    this.b = b;
    this.opts = opts;
  }

  private worldOf(item: ExpandItem, bases: ReadonlyMap<number, Uint8Array>): World {
    let start = item.chain.length;
    let w: World | undefined;
    for (; start > 0; start--) {
      const hit = this.worlds.get(item.chain[start - 1]!.idx);
      if (hit) {
        w = JSON.parse(hit);
        break;
      }
    }
    if (!w) {
      const hit = this.worlds.get(item.base);
      if (hit) w = JSON.parse(hit);
      else {
        const bytes = bases.get(item.base);
        if (!bytes) throw new EngineFault("Worker", `no checkpoint world for node ${item.base}`);
        w = unpack(bytes);
        this.worlds.set(item.base, JSON.stringify(w));
      }
      start = 0;
    }
    for (let i = start; i < item.chain.length; i++) {
      const link = item.chain[i]!;
      w = replayChain(this.b, w!, [link]);
      this.worlds.set(link.idx, JSON.stringify(w));
    }
    return w!;
  }

  expand(
    items: ReadonlyArray<ExpandItem>,
    bases: ReadonlyMap<number, Uint8Array>,
    skip: ReadonlySet<string>,
  ): Array<ExpandOut> {
    const out: Array<ExpandOut> = [];
    for (const item of items) {
      try {
        out.push(this.expandWorld(this.worldOf(item, bases), item.depth, skip, item.idx));
      } catch (e) {
        const f =
          e instanceof EngineFault
            ? e
            : new EngineFault("Worker", String((e as Error)?.stack ?? e));
        out.push({
          idx: item.idx,
          runs: 0,
          children: [],
          engine: [{ kind: f.kind, detail: f.detail }],
        });
      }
    }
    return out;
  }

  expandWorld(world: World, depth: number, skip: ReadonlySet<string>, idx = -1): ExpandOut {
    const b = this.b;
    const children: Array<ChildOut> = [];
    const engine: Array<EngineError> = [];
    let runs = 0;
    const childIsCheckpoint = (depth + 1) % this.opts.k === 0;
    for (const move of enabled(b, world)) {
      const { leaves, runs: n } = runAll(b, world, move);
      runs += n;
      for (const l of leaves) engine.push(...l.engine);
      if (engine.length > 0) break;
      for (const leaf of leaves) {
        const canon = canonOf(leaf.world);
        const step = stepOf(move, leaf);
        children.push({
          move: move.key,
          script: leaf.script,
          digest: canon.digest,
          ...(this.opts.exact ? { text: canon.text } : {}),
          viol: checkRules(b, leaf.world, step, skip),
          witnessed: witnessesOf(b, leaf.world, step, skip),
          hasMoves: depth + 1 >= this.opts.maxDepth ? enabled(b, leaf.world).length > 0 : true,
          ...(childIsCheckpoint ? { world: pack(leaf.world) } : {}),
        });
      }
    }
    return { idx, runs, children, engine };
  }
}
