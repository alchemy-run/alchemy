/**
 * Which bindings each part of a runtime can reach, recorded while the
 * runtime's Layers build and never declared by hand.
 *
 * A Function or Worker builds a tree of Layers: services, processes,
 * tools. Reading the program does not show that a tool's Layer does
 * `yield* JobService`, so the graph is recorded while the build runs, from
 * three observations:
 *
 * - **Frames**: one per memoized Layer build (from the runtime's
 *   `MemoMap`) and one per named term ({@link framed}): a process, a tool.
 *   A frame knows its parent and the service keys its build produced.
 * - **Lookups**: every `Context.get` a fiber performs, attributed to the
 *   frame current on that fiber. They are seen through `Tracer.context`,
 *   which Effect calls before each step: the fiber's context is swapped
 *   for a facade over the same service map that reports each `get`. So
 *   `yield*`, `serviceOption`, forked fibers and code behind `catchCause`
 *   are all seen.
 * - **Acquisitions**: every `Binding.Service` call (`ReadWriteBucket(b)`),
 *   attributed to the current frame. These are the permissions.
 *
 * A frame's permissions are its own acquisitions, its children's, and, for
 * every service key it looked up, those of the frame that provided the
 * key. That is how a tool that only does `yield* JobService` reaches the
 * bucket `JobServiceLive` bound.
 *
 * It is recorded at plan time. Without a graph in context every recorder
 * here does nothing.
 *
 * @module
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

/** `Layer` for a Layer build. Anything else names a kind of term: `Process`, `Tool`. */
export type FrameKind = "Layer" | (string & {});
export type NamedFrameKind = string;

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

/** A named term of a runtime (a process, a tool), with what it can reach. */
export interface CapabilityNode {
  readonly kind: string;
  readonly name: string;
  /** Every binding it reaches, itself or through what it uses. */
  readonly permissions: ReadonlyArray<Permission>;
  /** The named terms it uses. */
  readonly uses: ReadonlyArray<CapabilityNode>;
}

export interface CapabilityGraphShape {
  /** Mint a frame. */
  readonly frame: (kind: FrameKind, name: string | undefined, parent: Frame | undefined) => Frame;
  /** Record the services a Layer frame's build produced. */
  readonly provides: (frame: Frame, services: ReadonlyMap<string, unknown>) => void;
  /** Record one service lookup under a frame. */
  readonly uses: (frame: Frame, key: string, value: unknown) => void;
  /** Record one capability acquisition under a frame. */
  readonly acquires: (frame: Frame, acquisition: Acquisition) => void;
  /** Rename a frame after minting (a Layer frame learns its name from
   *  its output). */
  readonly label: (frame: Frame, name: string) => void;
  /** Every permission reachable from the frames of a named term. */
  readonly ofFrame: (kind: NamedFrameKind, name: string) => ReadonlyArray<Permission>;
  /**
   * The named terms, as a forest: each with its permissions and the named
   * terms it reaches (a process's tools). A term reached from another is
   * listed under it and not at the top.
   */
  readonly describe: () => ReadonlyArray<CapabilityNode>;
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
export class CapabilityGraph extends Context.Service<CapabilityGraph, CapabilityGraphShape>()(
  "alchemy/CapabilityGraph",
) {}

/** The frame current on this fiber. A `Context.Reference`, so reading
 *  it never charges the requirement channel. */
export const CurrentFrame: Context.Reference<Frame | undefined> = Context.Reference(
  "alchemy/CapabilityGraph/CurrentFrame",
  {
    defaultValue: (): Frame | undefined => undefined,
  },
);

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
    (typeof value === "object" || typeof value === "function") && value !== null;

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
        // The innermost Layer that produced a value finished first, and is
        // its provider. A Layer that merges others only passes theirs on.
        if (isObject(value)) {
          if (providersByValue.has(value)) continue;
          providersByValue.set(value, frame);
        }
        const set = providersByKey.get(key);
        if (set === undefined) providersByKey.set(key, new Set([frame]));
        else set.add(frame);
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
      if (map === undefined) acquisitions.set(frame, new Map([[id, acquisition]]));
      else if (!map.has(id)) map.set(id, acquisition);
    },
    label: (frame, name) => {
      (frame as { name: string | undefined }).name = name;
    },
    ofFrame: (kind, name) => closure(frames.filter((f) => f.kind === kind && f.name === name)),
    describe: () => {
      const idOf = (frame: Frame) => `${frame.kind}:${frame.name}`;
      const named = frames.filter((f) => f.kind !== "Layer" && f.name !== undefined);
      /** The named frames a frame reaches without passing through another named frame. */
      const reached = (root: Frame): ReadonlyArray<Frame> => {
        const out = new Map<string, Frame>();
        const visited = new Set<Frame>([root]);
        const walk = (frame: Frame): void => {
          const next = [
            ...(children.get(frame) ?? []),
            ...[...(uses.get(frame) ?? [])].flatMap(([key, value]) => [...providersOf(key, value)]),
          ];
          for (const each of next) {
            if (visited.has(each)) continue;
            visited.add(each);
            if (each.kind !== "Layer" && each.name !== undefined) {
              if (idOf(each) !== idOf(root)) out.set(idOf(each), each);
            } else walk(each);
          }
        };
        walk(root);
        return [...out.values()];
      };
      const byId = new Map<string, Array<Frame>>();
      for (const frame of named) {
        const group = byId.get(idOf(frame));
        if (group === undefined) byId.set(idOf(frame), [frame]);
        else group.push(frame);
      }
      const usesOf = new Map<string, ReadonlyArray<string>>();
      for (const [id, group] of byId) {
        usesOf.set(id, [...new Set(group.flatMap((frame) => reached(frame).map(idOf)))].sort());
      }
      const used = new Set([...usesOf.values()].flat());
      const node = (id: string, path: ReadonlySet<string>): CapabilityNode => {
        const group = byId.get(id)!;
        const used = (usesOf.get(id) ?? [])
          .filter((each) => !path.has(each))
          .map((each) => node(each, new Set([...path, id])));
        // What it reaches itself, and what the terms it uses reach.
        const reach = new Map<string, Permission>();
        for (const permission of [
          ...closure(group),
          ...used.flatMap((each) =>
            each.permissions.map((permission) => ({
              ...permission,
              via: [`${each.kind} ${each.name}`, ...permission.via],
            })),
          ),
        ]) {
          const row = keyOf(permission);
          const known = reach.get(row);
          if (known === undefined || known.via.length > permission.via.length) {
            reach.set(row, permission);
          }
        }
        return {
          kind: group[0]!.kind,
          name: group[0]!.name!,
          permissions: [...reach.values()],
          uses: used,
        };
      };
      return [...byId.keys()]
        .filter((id) => !used.has(id))
        .sort()
        .map((id) => node(id, new Set()));
    },
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
 * Run `effect` under a new named frame, a child of the current one:
 * `framed("Tool", name)(build)`. Without a graph in context it is `effect`.
 */
export const framed =
  (kind: NamedFrameKind, name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(
      Effect.all([Effect.serviceOption(CapabilityGraph), CurrentFrame]),
      ([graph, parent]) =>
        Option.isNone(graph)
          ? effect
          : Effect.provideService(effect, CurrentFrame, graph.value.frame(kind, name, parent)),
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
    // A fork missed and asked this map: build the Layer here, so that it is
    // framed (`Layer.build` exists, but is hidden from the typings).
    real.get(layer, scope) ??
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a Layer of any services: the map is generic over what it builds
    (
      layer as unknown as {
        build: (
          memoMap: Layer.MemoMap,
          scope: Scope.Scope,
        ) => Effect.Effect<Context.Context<any>, any, any>;
      }
    ).build(self, scope);
  const getOrElseMemoize: Layer.MemoMap["getOrElseMemoize"] = (layer, scope, build) =>
    // The Layer is built with this map, not the real one it is stored in, so
    // that the Layers it builds in turn are framed too.
    real.getOrElseMemoize(layer, scope, (_, layerScope) =>
      Effect.flatMap(CurrentFrame, (parent) => {
        const frame = graph.frame("Layer", undefined, parent);
        return Effect.tap(
          Effect.provideService(build(self, layerScope), CurrentFrame, frame),
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
  onGet: (key: string, value: unknown, real: ReadonlyMap<string, unknown>) => void,
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
      f: (value: unknown, key: string, map: ReadonlyMap<string, unknown>) => void,
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
      const onGet = (key: string, value: unknown, real: ReadonlyMap<string, unknown>) => {
        // the frame lives in the SAME map (a Reference row), so read
        // it from the real map — never through the facade
        const frame = real.get(CurrentFrame.key) as Frame | undefined;
        if (frame !== undefined) graph.uses(frame, key, value);
      };
      const rewrap = (fiber: Fiber.Fiber<any, any>) => {
        const map = fiber.context.mapUnsafe as unknown as Record<symbol, unknown>;
        if (RECORDING in map) return;
        fiber.setContext(Context.makeUnsafe(recordingMap(fiber.context.mapUnsafe, onGet)));
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
export const recordAcquisition = (acquisition: Acquisition): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.all([Effect.serviceOption(CapabilityGraph), CurrentFrame]),
    ([graph, frame]) =>
      Effect.sync(() => {
        if (Option.isSome(graph) && frame !== undefined) {
          graph.value.acquires(frame, acquisition);
        }
      }),
  );
