/**
 * THE CAPABILITY GRAPH — who can reach which cloud capability, derived
 * from the Layer build itself, never declared by hand.
 *
 * A Function/Worker's `impl` builds a tree of Layers (services, agents,
 * skills, tools). The engine cannot see `yield* JobService` by reading
 * the program — monadic continuations are opaque until run — so the
 * graph is recorded WHILE the build runs, from three observations:
 *
 * - **Frames** — one per memoized Layer build (from the platform's
 *   `MemoMap`) and one per named AI term (Agent / Skill / Group / Tool
 *   inits, via {@link framed}). A frame knows its parent and the
 *   service KEYS its build produced (`provides`).
 * - **Lookups** — every `Context.get` the fiber performs, attributed to
 *   the frame current on that fiber (`uses`). Captured through
 *   `Tracer.context`, Effect's per-primitive evaluation hook: before
 *   each step the fiber's context is swapped for a recording facade
 *   over the same service map, so the observation is complete —
 *   `yield*`, `Tag.use`, `Effect.all`, `serviceOption`, nested
 *   `Effect.provide`, forked fibers, and code behind `catchCause` all
 *   end in the same `get`.
 * - **Acquisitions** — every `Binding.Service` call (`ReadWriteBucket(b)`,
 *   `GitHub.GetIssue(repo)`), attributed to the current frame
 *   (`acquires`). These are the permission rows.
 *
 * The query is a closure: a frame's permissions are its own
 * acquisitions, its children's, and — for every service key it looked
 * up — the permissions of the frame that PROVIDED that key. That is
 * how a tool's `yield* JobService` reaches the bucket `JobServiceLive`
 * bound, even though the service was provided to the agent outside
 * the tool's own init.
 *
 * Runs at plan time AND at isolate boot (the same build), so a
 * deployed host can serve its own permission table. Measured cost:
 * a few milliseconds per build. Absent a graph (no platform), every
 * recorder here is a no-op.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

export type FrameKind = "Layer" | "Agent" | "Skill" | "Group" | "Tool";
export type NamedFrameKind = Exclude<FrameKind, "Layer">;

/** One attribution scope: a Layer build or a named AI term's init. */
export interface Frame {
  readonly id: number;
  readonly kind: FrameKind;
  /** The term's name (named frames); the first provided key (Layers). */
  readonly name: string | undefined;
  readonly parent: Frame | undefined;
}

/** One capability acquisition — a `Binding.Service` resolved against
 *  its target resource(s). The permission row. */
export interface Acquisition {
  /** The `Binding.Service` key, e.g. `Cloudflare.R2.BucketReadWrite`. */
  readonly binding: string;
  /** The target resources' identities (`Type(logicalId)`); empty for
   *  account-scoped capabilities. */
  readonly targets: ReadonlyArray<string>;
}

/** An acquisition as REACHED from a queried frame: `via` is the chain
 *  of service keys that led to the acquiring frame (empty when the
 *  frame acquired it directly). */
export interface Permission extends Acquisition {
  readonly via: ReadonlyArray<string>;
}

export interface CapabilityGraphShape {
  /** Mint a frame. */
  readonly frame: (
    kind: FrameKind,
    name: string | undefined,
    parent: Frame | undefined,
  ) => Frame;
  /** Record the services a Layer frame's build produced. */
  readonly provides: (
    frame: Frame,
    services: ReadonlyMap<string, unknown>,
  ) => void;
  /** Record one service lookup under a frame. */
  readonly uses: (frame: Frame, key: string, value: unknown) => void;
  /** Record one capability acquisition under a frame. */
  readonly acquires: (frame: Frame, acquisition: Acquisition) => void;
  /** Rename a frame after minting (a Layer frame learns its name from
   *  its output). */
  readonly label: (frame: Frame, name: string) => void;
  /** Every permission reachable from the frames of a named term. */
  readonly ofFrame: (
    kind: NamedFrameKind,
    name: string,
  ) => ReadonlyArray<Permission>;
  /** Every permission reachable from the Layer that provides a
   *  service key (a class tool's physics, a skill's service). */
  readonly ofService: (key: string) => ReadonlyArray<Permission>;
  /** The recorded frames (diagnostics). */
  readonly frames: () => ReadonlyArray<Frame>;
  /** Forget everything — a fresh build in the same process. */
  readonly reset: () => void;
}

/**
 * The graph, as a service. Provided by the platform (`Platform.ts`) to
 * every Function/Worker `impl`, so a route can `yield* CapabilityGraph`
 * and serve the table. OPTIONAL everywhere it is read: absent, the
 * recorders are no-ops.
 */
export class CapabilityGraph extends Context.Service<
  CapabilityGraph,
  CapabilityGraphShape
>()("alchemy/CapabilityGraph") {}

/** The frame current on this fiber. A `Context.Reference`, so reading
 *  it never charges the requirement channel. */
export const CurrentFrame: Context.Reference<Frame | undefined> =
  Context.Reference("alchemy/CapabilityGraph/CurrentFrame", {
    defaultValue: (): Frame | undefined => undefined,
  });

const keyOf = (acquisition: Acquisition): string =>
  `${acquisition.binding}|${acquisition.targets.join(",")}`;

/** An in-memory {@link CapabilityGraph}. */
export const makeCapabilityGraph = (): CapabilityGraphShape => {
  let nextId = 0;
  let frames: Array<{ -readonly [K in keyof Frame]: Frame[K] }> = [];
  const children = new Map<Frame, Frame[]>();
  const uses = new Map<Frame, Map<string, unknown>>();
  const acquisitions = new Map<Frame, Map<string, Acquisition>>();
  /** key → frames whose build produced it (several when two Layers
   *  provide one tag). */
  const providersByKey = new Map<string, Set<Frame>>();
  /** the produced service VALUE → its frame: disambiguates by identity
   *  when two Layers provide the same key. */
  const providersByValue = new WeakMap<object, Frame>();

  const isObject = (value: unknown): value is object =>
    (typeof value === "object" || typeof value === "function") &&
    value !== null;

  const providersOf = (key: string, value: unknown): ReadonlySet<Frame> => {
    if (isObject(value)) {
      const exact = providersByValue.get(value);
      if (exact !== undefined) return new Set([exact]);
    }
    return providersByKey.get(key) ?? new Set();
  };

  const collect = (
    frame: Frame,
    via: ReadonlyArray<string>,
    out: Map<string, Permission>,
    visited: Set<Frame>,
  ): void => {
    if (visited.has(frame)) return;
    visited.add(frame);
    for (const acquisition of acquisitions.get(frame)?.values() ?? []) {
      const id = keyOf(acquisition);
      const existing = out.get(id);
      // keep the SHORTEST chain to each acquisition
      if (existing === undefined || existing.via.length > via.length) {
        out.set(id, { ...acquisition, via });
      }
    }
    for (const child of children.get(frame) ?? []) {
      collect(child, via, out, visited);
    }
    for (const [key, value] of uses.get(frame) ?? []) {
      for (const provider of providersOf(key, value)) {
        collect(provider, [...via, key], out, visited);
      }
    }
  };

  const closure = (roots: Iterable<Frame>): ReadonlyArray<Permission> => {
    const out = new Map<string, Permission>();
    const visited = new Set<Frame>();
    for (const root of roots) collect(root, [], out, visited);
    return [...out.values()].sort((a, b) =>
      a.via.length !== b.via.length
        ? a.via.length - b.via.length
        : a.binding < b.binding
          ? -1
          : a.binding > b.binding
            ? 1
            : a.targets.join() < b.targets.join()
              ? -1
              : 1,
    );
  };

  return {
    frame: (kind, name, parent) => {
      const frame = { id: nextId++, kind, name, parent };
      frames.push(frame);
      if (parent !== undefined) {
        const siblings = children.get(parent);
        if (siblings === undefined) children.set(parent, [frame]);
        else siblings.push(frame);
      }
      return frame;
    },
    provides: (frame, services) => {
      for (const [key, value] of services) {
        const set = providersByKey.get(key);
        if (set === undefined) providersByKey.set(key, new Set([frame]));
        else set.add(frame);
        if (isObject(value)) providersByValue.set(value, frame);
      }
    },
    uses: (frame, key, value) => {
      const map = uses.get(frame);
      if (map === undefined) uses.set(frame, new Map([[key, value]]));
      else if (!map.has(key)) map.set(key, value);
    },
    acquires: (frame, acquisition) => {
      const map = acquisitions.get(frame);
      const id = keyOf(acquisition);
      if (map === undefined)
        acquisitions.set(frame, new Map([[id, acquisition]]));
      else if (!map.has(id)) map.set(id, acquisition);
    },
    label: (frame, name) => {
      (frame as { name: string | undefined }).name = name;
    },
    ofFrame: (kind, name) =>
      closure(frames.filter((f) => f.kind === kind && f.name === name)),
    ofService: (key) => closure(providersByKey.get(key) ?? []),
    frames: () => frames,
    reset: () => {
      nextId = 0;
      frames = [];
      children.clear();
      uses.clear();
      acquisitions.clear();
      providersByKey.clear();
    },
  };
};

/**
 * Run `effect` under a NEW named frame (a child of the current one) —
 * `framed("Agent", term)(charter)`, `framed("Tool", name)(def.init)`.
 * A no-op without a graph in context.
 */
export const framed =
  (kind: NamedFrameKind, name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(
      Effect.all([Effect.serviceOption(CapabilityGraph), CurrentFrame]),
      ([graph, parent]) =>
        Option.isNone(graph)
          ? effect
          : Effect.provideService(
              effect,
              CurrentFrame,
              graph.value.frame(kind, name, parent),
            ),
    );

/** `Layer.MemoMap`'s brand — not exported by Effect. */
const MEMO_MAP_TYPE_ID = "~effect/Layer/MemoMap";

/**
 * Wrap a `MemoMap` so every memoized Layer built through it (or
 * through any fork of it — `Effect.provide` forks the current map and
 * forks ask their parent on a miss) gets a Layer frame: its build runs
 * with that frame current, and its output services are recorded as
 * the frame's `provides`.
 */
export const observeLayerBuilds = (
  real: Layer.MemoMap,
  graph: CapabilityGraphShape,
): Layer.MemoMap => {
  const get: Layer.MemoMap["get"] = (layer, scope) =>
    // a fork missed and asked us: build it HERE so the build is framed
    // (`Layer.build` is on the interface but hidden from the typings)
    real.get(layer, scope) ??
    (
      layer as unknown as {
        build: (
          memoMap: Layer.MemoMap,
          scope: Scope.Scope,
        ) => Effect.Effect<Context.Context<any>, any, any>;
      }
    ).build(self, scope);
  const getOrElseMemoize: Layer.MemoMap["getOrElseMemoize"] = (
    layer,
    scope,
    build,
  ) =>
    real.getOrElseMemoize(layer, scope, (memoMap, layerScope) =>
      Effect.flatMap(CurrentFrame, (parent) => {
        const frame = graph.frame("Layer", undefined, parent);
        return Effect.tap(
          Effect.provideService(
            build(memoMap, layerScope),
            CurrentFrame,
            frame,
          ),
          (out) =>
            Effect.sync(() => {
              const services = out.mapUnsafe;
              graph.provides(frame, services);
              const first = services.keys().next();
              if (!first.done) graph.label(frame, first.value);
            }),
        );
      }),
    );
  const self = {
    [MEMO_MAP_TYPE_ID]: MEMO_MAP_TYPE_ID,
    get,
    getOrElseMemoize,
  } as unknown as Layer.MemoMap;
  return self;
};

const RECORDING = Symbol.for("alchemy/CapabilityGraph/recording");
const EVALUATE = "~effect/Effect/evaluate" as const;

/** A `ReadonlyMap` facade over a service map that reports every `get`. */
const recordingMap = (
  real: ReadonlyMap<string, unknown>,
  onGet: (
    key: string,
    value: unknown,
    real: ReadonlyMap<string, unknown>,
  ) => void,
): ReadonlyMap<string, unknown> =>
  ({
    [RECORDING]: true,
    get: (key: string) => {
      const value = real.get(key);
      onGet(key, value, real);
      return value;
    },
    has: (key: string) => real.has(key),
    get size() {
      return real.size;
    },
    forEach: (
      f: (
        value: unknown,
        key: string,
        map: ReadonlyMap<string, unknown>,
      ) => void,
      thisArg?: unknown,
    ) => real.forEach(f, thisArg),
    keys: () => real.keys(),
    values: () => real.values(),
    entries: () => real.entries(),
    [Symbol.iterator]: () => real[Symbol.iterator](),
  }) as unknown as ReadonlyMap<string, unknown>;

/**
 * Observe every service lookup `effect` (and its child fibers)
 * performs, attributing each to the frame current on the looking-up
 * fiber. Installs a `Tracer` whose `context` hook re-wraps the fiber's
 * context in a recording facade before each primitive; any existing
 * tracer's own hook still runs. Defensive: a failure to wrap degrades
 * to plain evaluation (an emptier graph), never a failed build.
 */
export const observeLookups =
  (graph: CapabilityGraphShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Tracer.Tracer, (base) => {
      const onGet = (
        key: string,
        value: unknown,
        real: ReadonlyMap<string, unknown>,
      ) => {
        // the frame lives in the SAME map (a Reference row), so read
        // it from the real map — never through the facade
        const frame = real.get(CurrentFrame.key) as Frame | undefined;
        if (frame !== undefined) graph.uses(frame, key, value);
      };
      const rewrap = (fiber: Fiber.Fiber<any, any>) => {
        const map = fiber.context.mapUnsafe as unknown as Record<
          symbol,
          unknown
        >;
        if (RECORDING in map) return;
        fiber.setContext(
          Context.makeUnsafe(recordingMap(fiber.context.mapUnsafe, onGet)),
        );
      };
      const tracer = Tracer.make({
        span: (options) => base.span(options),
        context: (primitive, fiber) => {
          try {
            rewrap(fiber);
          } catch {
            // degrade to an unobserved step
          }
          return base.context !== undefined
            ? base.context(primitive, fiber)
            : primitive[EVALUATE](fiber);
        },
      });
      return Effect.provideService(effect, Tracer.Tracer, tracer);
    });

/**
 * Record one capability acquisition under the current frame. Called by
 * `Binding.Service` on every bind; a no-op without a graph.
 */
export const recordAcquisition = (
  acquisition: Acquisition,
): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.all([Effect.serviceOption(CapabilityGraph), CurrentFrame]),
    ([graph, frame]) =>
      Effect.sync(() => {
        if (Option.isSome(graph) && frame !== undefined) {
          graph.value.acquires(frame, acquisition);
        }
      }),
  );
