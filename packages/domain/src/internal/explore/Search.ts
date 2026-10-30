/**
 * The searches: BFS (bounded batches, incremental acceptance, a frontier
 * without worlds) and the seeded swarm.
 */
import { collisionBound, DIGEST_ALGORITHM, digestHex, Visited, type Digest } from "./Canonical.ts";
import {
  canonOf,
  checkRules,
  enabled,
  freshWorld,
  runOnce,
  stepOf,
  witnessesOf,
  type Built,
  type Move,
} from "./Engine.ts";
import { EngineFault, type EngineError } from "./Errors.ts";
import {
  Expander,
  pack,
  type ChildOut,
  type ExpandItem,
  type ExpandOptions,
  type ExpandOut,
} from "./Expand.ts";
import type { ScriptEntry, World } from "./Host.ts";
import { replayChain } from "./Trace.ts";

// ─────────────────────────────────────────────────────────── Steps ──

/** Packed parent records: (parent, move, script, depth) per state. */
class Steps {
  parent = new Int32Array(1 << 16);
  move = new Int32Array(1 << 16);
  script = new Int32Array(1 << 16);
  depth = new Uint16Array(1 << 16);
  /** Four words per state: the digest the search saw, kept to check a witness. */
  digests = new Uint32Array(4 << 16);
  n = 0;
  private readonly moves: Array<string> = [];
  private readonly moveIds = new Map<string, number>();
  private readonly scripts: Array<string> = [];
  private readonly scriptIds = new Map<string, number>();

  push(parent: number, move: string, script: ReadonlyArray<ScriptEntry>, depth: number, d: Digest) {
    if (this.n === this.parent.length) {
      const grow = <T extends Int32Array | Uint16Array | Uint32Array>(a: T): T => {
        const b = new (a.constructor as any)(a.length * 2);
        b.set(a);
        return b;
      };
      this.parent = grow(this.parent);
      this.move = grow(this.move);
      this.script = grow(this.script);
      this.depth = grow(this.depth);
      this.digests = grow(this.digests);
    }
    const i = this.n++;
    this.parent[i] = parent;
    this.move[i] = this.intern(this.moves, this.moveIds, move);
    this.script[i] = this.intern(this.scripts, this.scriptIds, JSON.stringify(script));
    this.depth[i] = depth;
    this.digests.set(d, i * 4);
    return i;
  }

  private intern(list: Array<string>, ids: Map<string, number>, s: string) {
    let id = ids.get(s);
    if (id === undefined) {
      id = list.length;
      list.push(s);
      ids.set(s, id);
    }
    return id;
  }

  link(i: number) {
    return {
      idx: i,
      move: this.moves[this.move[i]!]!,
      script: JSON.parse(this.scripts[this.script[i]!]!) as Array<ScriptEntry>,
      digest: digestHex([...this.digests.subarray(i * 4, i * 4 + 4)] as unknown as Digest),
    };
  }

  /** The moves from the root to `i`. */
  chain(i: number) {
    const out: Array<ReturnType<Steps["link"]>> = [];
    for (let j = i; j > 0; j = this.parent[j]!) out.unshift(this.link(j));
    return out;
  }

  get bytes() {
    return this.parent.byteLength * 3 + this.depth.byteLength + this.digests.byteLength;
  }
}

// ───────────────────────────────────────────────────────── Results ──

export type Coverage =
  | { readonly _tag: "Exhausted" }
  | { readonly _tag: "WithinDepth"; readonly depth: number }
  | { readonly _tag: "CutOff"; readonly reason: string }
  | { readonly _tag: "Sampled"; readonly seeds: ReadonlyArray<number>; readonly walks: number };

export interface Found {
  readonly rule: string;
  readonly message: string;
  readonly chain: Array<{ move: string; script: Array<ScriptEntry>; digest: string }>;
  readonly states: number;
  readonly ms: number;
}

export interface SearchResult {
  readonly coverage: Coverage;
  readonly states: number;
  readonly transitions: number;
  readonly moveRuns: number;
  readonly depth: number;
  readonly ms: number;
  /** CPU seconds of the whole process (coordinator and worker threads): the wall time lies on a loaded machine. */
  readonly cpuSec: number;
  readonly peakRssMb: number;
  readonly found: Array<Found>;
  /** Rules whose trigger the run witnessed. */
  readonly witnessed: Array<string>;
  readonly engine: Array<EngineError>;
  readonly memory: {
    readonly visitedMb: number;
    readonly stepsMb: number;
    readonly checkpointsMb: number;
  };
  readonly identity: {
    readonly mode: "digest" | "exact";
    readonly algorithm: string;
    /** A digest match counts as the same state without a compare: true in `digest` mode. */
    readonly probabilistic: boolean;
    readonly collisions: number;
    readonly collisionBound: number;
  };
}

export interface Pool {
  readonly size: number;
  expand(
    items: Array<ExpandItem>,
    bases: Map<number, Uint8Array>,
    skip: Array<string>,
  ): Promise<Array<ExpandOut>>;
  stop(): void;
}

export interface SearchOptions extends ExpandOptions {
  readonly maxDepth: number;
  readonly states: number;
  readonly elapsedMillis: number;
  readonly memoryBytes: number;
  readonly batch: number;
  /** Replay a new state's chain on the shadow build every N states (hidden-state check). */
  readonly freshEvery: number;
  readonly progress?: (line: string) => void;
}

const rssMb = () => Math.round(process.memoryUsage().rss / 1e6);
export const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

// ───────────────────────────────────────────────────────────── BFS ──

export const bfs = async (
  b: Built,
  shadow: Built,
  opts: SearchOptions,
  pool: Pool | undefined,
): Promise<SearchResult> => {
  const t0 = performance.now();
  const c0 = cpuNow();
  const steps = new Steps();
  const visited = new Visited(opts.exact ? "exact" : "digest");
  const checkpoints = new Map<number, Uint8Array>();
  const checkpointsAt = new Map<number, Array<number>>();
  let checkpointBytes = 0;
  const found = new Map<string, Found>();
  const witnessed = new Set<string>();
  const engine: Array<EngineError> = [];
  let transitions = 0;
  let moveRuns = 0;
  let maxDepth = 0;
  let peak = rssMb();
  let depthCut = false;
  let cut: string | undefined;
  const local = new Expander(b, opts);

  // Root.
  const w0 = freshWorld(b.scenario);
  const root = canonOf(w0);
  visited.add(root.digest, opts.exact ? root.text : undefined);
  steps.push(-1, "", [], 0, root.digest);
  checkpoints.set(0, pack(w0));
  for (const [rule, message] of checkRules(b, w0, undefined))
    found.set(rule, { rule, message, chain: [], states: 1, ms: 0 });
  for (const id of witnessesOf(b, w0, undefined)) witnessed.add(id);
  let level: Array<number> = [0];
  if (enabled(b, w0).length > 0 && opts.maxDepth === 0) depthCut = true;

  const capped = () => {
    peak = Math.max(peak, rssMb());
    if (visited.size >= opts.states) cut = `states ${opts.states}`;
    else if (performance.now() - t0 > opts.elapsedMillis)
      cut = `time ${Math.round(opts.elapsedMillis / 1000)}s`;
    else if (peak * 1e6 > opts.memoryBytes)
      cut = `memory ${Math.round(opts.memoryBytes / 1e9)}GB (rss ${peak}MB)`;
    return cut !== undefined;
  };

  const itemOf = (idx: number): ExpandItem => {
    const chain: Array<ReturnType<Steps["link"]>> = [];
    let j = idx;
    while (!checkpoints.has(j)) {
      chain.unshift(steps.link(j));
      j = steps.parent[j]!;
    }
    return { idx, depth: steps.depth[idx]!, base: j, chain };
  };

  const accept = (out: ExpandOut, next: Array<number>) => {
    moveRuns += out.runs;
    if (out.engine.length > 0) {
      engine.push(...out.engine);
      return;
    }
    const parentDepth = steps.depth[out.idx]!;
    for (const child of out.children) {
      transitions++;
      for (const id of child.witnessed) witnessed.add(id);
      for (const [rule, message] of child.viol)
        if (!found.has(rule))
          found.set(rule, {
            rule,
            message,
            chain: [
              ...steps.chain(out.idx),
              { move: child.move, script: child.script, digest: digestHex(child.digest) },
            ],
            states: visited.size,
            ms: Math.round(performance.now() - t0),
          });
      if (!visited.add(child.digest, child.text)) continue;
      const depth = parentDepth + 1;
      const idx = steps.push(out.idx, child.move, child.script, depth, child.digest);
      maxDepth = Math.max(maxDepth, depth);
      if (child.world) storeCheckpoint(idx, depth, child.world);
      if (depth < opts.maxDepth) next.push(idx);
      else if (child.hasMoves) depthCut = true;
      if (opts.freshEvery > 0 && visited.size % opts.freshEvery === 0)
        shadowCheck(idx, child.digest);
    }
  };

  const storeCheckpoint = (idx: number, depth: number, world: Uint8Array) => {
    checkpoints.set(idx, world);
    checkpointBytes += world.byteLength;
    (checkpointsAt.get(depth) ?? checkpointsAt.set(depth, []).get(depth)!).push(idx);
  };

  const shadowCheck = (idx: number, d: Digest) => {
    try {
      const r = replayChain(shadow, steps.chain(idx));
      const got = r.steps[r.steps.length - 1]?.digest;
      if (got !== digestHex(d))
        engine.push({
          kind: "HiddenState",
          detail: `node ${idx}: a second build reached digest ${got}, the search ${digestHex(d)}`,
        });
    } catch (e) {
      engine.push({
        kind: e instanceof EngineFault ? e.kind : "HiddenState",
        detail: String((e as Error).message),
      });
    }
  };

  while (level.length > 0 && engine.length === 0 && !capped()) {
    const next: Array<number> = [];
    const depthNow = steps.depth[level[0]!]!;
    // Free checkpoints no node of this level or later needs.
    const keepFrom = Math.floor(depthNow / opts.k) * opts.k;
    for (const [d, list] of checkpointsAt)
      if (d < keepFrom) {
        for (const i of list) {
          checkpointBytes -= checkpoints.get(i)!.byteLength;
          checkpoints.delete(i);
        }
        checkpointsAt.delete(d);
      }
    const batches: Array<Array<number>> = [];
    for (let i = 0; i < level.length; i += opts.batch) batches.push(level.slice(i, i + opts.batch));
    const skip = () => [...found.keys(), ...[...witnessed].map((id) => `witness:${id}`)];
    if (!pool) {
      for (const ids of batches) {
        const items = ids.map(itemOf);
        const bases = new Map(items.map((it) => [it.base, checkpoints.get(it.base)!] as const));
        for (const out of local.expand(items, bases, new Set(skip()))) accept(out, next);
        if (engine.length > 0 || capped()) break;
      }
    } else {
      // Bounded in-flight batches; replies are accepted in batch order (determinism).
      const inflight = new Map<number, Promise<Array<ExpandOut>>>();
      let sent = 0;
      let taken = 0;
      const send = () => {
        const ids = batches[sent]!;
        const items = ids.map(itemOf);
        const bases = new Map(items.map((it) => [it.base, checkpoints.get(it.base)!] as const));
        inflight.set(sent, pool.expand(items, bases, skip()));
        sent++;
      };
      while (sent < batches.length && inflight.size < pool.size * 2) send();
      while (taken < sent) {
        const outs = await inflight.get(taken)!;
        inflight.delete(taken);
        for (const out of outs) accept(out, next);
        taken++;
        if (engine.length > 0 || capped()) break;
        if (sent < batches.length) send();
      }
      if (taken < sent) await Promise.allSettled(inflight.values());
    }
    opts.progress?.(
      `depth ${depthNow} frontier ${level.length} states ${visited.size} transitions ${transitions} ${Math.round(performance.now() - t0)}ms cpu ${Math.round(cpuNow() - c0)}s rss ${rssMb()}MB checkpoints ${Math.round(checkpointBytes / 1e6)}MB`,
    );
    if (engine.length > 0 || cut) break;
    level = next;
  }
  const coverage: Coverage =
    engine.length > 0
      ? { _tag: "CutOff", reason: "engine-error" }
      : cut
        ? { _tag: "CutOff", reason: cut }
        : depthCut
          ? { _tag: "WithinDepth", depth: opts.maxDepth }
          : { _tag: "Exhausted" };
  return {
    coverage,
    states: visited.size,
    transitions,
    moveRuns,
    depth: maxDepth,
    ms: Math.round(performance.now() - t0),
    cpuSec: Math.round(cpuNow() - c0),
    peakRssMb: Math.max(peak, rssMb()),
    found: [...found.values()],
    witnessed: [...witnessed],
    engine,
    memory: {
      visitedMb: Math.round(visited.bytes / 1e6),
      stepsMb: Math.round(steps.bytes / 1e6),
      checkpointsMb: Math.round(checkpointBytes / 1e6),
    },
    identity: {
      mode: visited.mode,
      algorithm: DIGEST_ALGORITHM,
      probabilistic: visited.mode === "digest",
      collisions: visited.collisions,
      collisionBound: collisionBound(visited.size),
    },
  };
};

// ─────────────────────────────────────────────────────────── Swarm ──

export interface SwarmOptions {
  readonly seeds: ReadonlyArray<number>;
  /** Walks per seed (deterministic). */
  readonly walks?: number;
  /** A time box per seed (not deterministic across machines). */
  readonly timeMillis?: number;
  readonly depth: number;
  /** Weight per move kind (default: timer, run, tick ×3; actor, redeliver ×1). */
  readonly weights?: Partial<Record<Move["kind"], number>>;
  /** Shrink each hit: drop moves while the same rule still breaks. */
  readonly shrink?: boolean;
}

export interface SwarmLimits {
  readonly elapsedMillis: number;
  readonly memoryBytes: number;
  /** Move runs per seed. */
  readonly states: number;
}

type Link = { move: string; script: Array<ScriptEntry>; digest: string };

export interface SwarmHit {
  readonly rule: string;
  readonly message: string;
  readonly seed: number;
  readonly walk: number;
  readonly runs: number;
  readonly ms: number;
  readonly chain: Array<Link>;
  readonly rawLength: number;
}

/** mulberry32 */
export const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const DEFAULT_WEIGHTS: Record<Move["kind"], number> = {
  actor: 1,
  run: 3,
  timer: 3,
  tick: 3,
  redeliver: 1,
};

/** One seed of timer-biased random walks. Same seed and walk count → same result. */
export const swarmSeed = (
  b: Built,
  seed: number,
  opts: SwarmOptions,
  limits: SwarmLimits,
): {
  hits: Array<SwarmHit>;
  witnessed: Array<string>;
  walks: number;
  runs: number;
  ms: number;
  engine: Array<EngineError>;
} => {
  const t0 = performance.now();
  const rand = rng(seed);
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const hits = new Map<string, SwarmHit>();
  const witnessed = new Set<string>();
  const engine: Array<EngineError> = [];
  let runs = 0;
  let walk = 0;
  const w0 = freshWorld(b.scenario);
  for (const [rule, message] of checkRules(b, w0, undefined))
    hits.set(rule, { rule, message, seed, walk: 0, runs: 0, ms: 0, chain: [], rawLength: 0 });
  for (const id of witnessesOf(b, w0, undefined)) witnessed.add(id);
  const inLimits = () =>
    performance.now() - t0 < limits.elapsedMillis &&
    runs < limits.states &&
    process.memoryUsage().rss < limits.memoryBytes;
  const more = () =>
    inLimits() &&
    (opts.walks !== undefined
      ? walk < opts.walks
      : performance.now() - t0 < (opts.timeMillis ?? 10_000));
  while (more() && engine.length === 0) {
    walk++;
    let world = w0;
    const chain: Array<Link> = [];
    for (let d = 0; d < opts.depth; d++) {
      const moves = enabled(b, world);
      if (moves.length === 0) break;
      const total = moves.reduce((s, m) => s + weights[m.kind], 0);
      let x = rand() * total;
      let move = moves[moves.length - 1]!;
      for (const m of moves) {
        x -= weights[m.kind];
        if (x < 0) {
          move = m;
          break;
        }
      }
      b.rt.random = rand;
      const leaf = (() => {
        try {
          return runOnce(b, world, move, []);
        } finally {
          b.rt.random = undefined;
        }
      })();
      runs++;
      if (leaf.engine.length > 0) {
        engine.push(...leaf.engine);
        break;
      }
      let digest: string;
      try {
        // The same state check as BFS: a value JSON would change is an engine error.
        digest = digestHex(canonOf(leaf.world).digest);
      } catch (e) {
        const f = e instanceof EngineFault ? e : new EngineFault("NonJsonState", String(e));
        engine.push({ kind: f.kind, detail: f.detail, move: move.key });
        break;
      }
      chain.push({ move: move.key, script: leaf.script, digest });
      const step = stepOf(move, leaf);
      for (const id of witnessesOf(b, leaf.world, step)) witnessed.add(id);
      for (const [rule, message] of checkRules(b, leaf.world, step))
        if (!hits.has(rule))
          hits.set(rule, {
            rule,
            message,
            seed,
            walk,
            runs,
            ms: Math.round(performance.now() - t0),
            chain: [...chain],
            rawLength: chain.length,
          });
      world = leaf.world;
    }
  }
  const out = [...hits.values()].map((h) =>
    opts.shrink === false
      ? h
      : { ...h, chain: shrink(b, h.rule, h.chain, t0 + limits.elapsedMillis) },
  );
  return {
    hits: out,
    witnessed: [...witnessed],
    walks: walk,
    runs,
    ms: Math.round(performance.now() - t0),
    engine,
  };
};

/** Greedy: drop one move at a time (last first) while the replay still breaks the same rule at its end. */
export const shrink = (b: Built, rule: string, chain: Array<Link>, until: number) => {
  let best = chain;
  let changed = true;
  while (changed && performance.now() < until) {
    changed = false;
    for (let i = best.length - 1; i >= 0 && performance.now() < until; i--) {
      const cand = [...best.slice(0, i), ...best.slice(i + 1)];
      try {
        const r = replayChain(b, cand);
        if (r.breaks.some(([id]) => id === rule)) {
          best = cand.map((l, n) => ({ ...l, digest: r.steps[n]!.digest }));
          changed = true;
        }
      } catch {
        // not enabled / another branch: keep the move
      }
    }
  }
  return best;
};
