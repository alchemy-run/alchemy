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
 * - **References**: what a term says it uses ({@link refer}): a process's
 *   tools, the views and commands of a Domain model it mentions.
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
 * The plan's list is also the limit at runtime. The plan stores it on the
 * runtime as a {@link Policy}, and every client a `Binding.Service` hands out
 * checks it: a call made while a tool runs ({@link calling}) dies with
 * {@link CapabilityDenied} unless the plan listed that binding under the
 * tool. So a tool that closes over a client bound somewhere else, which the
 * build could not see, fails on its first use and never works unseen.
 *
 * @module
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { RuntimeContext } from "./RuntimeContext.ts";

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

/** An edge from one term to another: a process uses a tool, gets a view, sends a command. */
export interface Reference {
  /** How it is used: `uses`, or the operation on a Domain piece (`get`, `send`). */
  readonly relation: string;
  /** The {@link Term.id} it points at. Every reference of a runtime resolves to one of its terms. */
  readonly to: string;
}

/**
 * One named thing a runtime runs or reaches: a process, a tool, a piece of a
 * Domain model. A runtime's terms are a flat list: walk it by `id`, and
 * follow `references` from one term to the next.
 */
export interface Term {
  /** `Kind:name`, unique within the runtime. */
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  /** What runs it inside the runtime, where that is not the runtime itself: a Durable Object's name. */
  readonly host?: string;
  /** The bindings it may use itself. What it reaches through a term it references is on that term. */
  readonly bindings: ReadonlyArray<Permission>;
  /** The terms it uses. */
  readonly references: ReadonlyArray<Reference>;
  /**
   * The runtime's bindings that are this term's own resources, by name: the
   * Durable Objects of a Domain model's aggregates, views and policies.
   */
  readonly resources?: ReadonlyArray<string>;
}

/** The kind of the frame around what a runtime hosts: a Durable Object. It is not a term. */
export const HOST = "Host";

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
  /** Record that one of the runtime's bindings is a resource of a term. */
  readonly owns: (kind: string, name: string, resource: string) => void;
  /** Mark a frame's term as having no host. */
  readonly unhosted: (frame: Frame) => void;
  /** Record what hosts a term that is not built inside its host. */
  readonly hosts: (kind: string, name: string, host: string) => void;
  /** Record that a value given out for a term is the term: a lookup that receives it reaches the term. */
  readonly stands: (kind: string, name: string, value: unknown) => void;
  /** Record that a frame's term uses another term. */
  readonly refers: (frame: Frame, relation: string, kind: string, name: string) => void;
  /** The runtime's terms, sorted by id. */
  readonly describe: () => ReadonlyArray<Term>;
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
const FRAME_KEY = "alchemy/CapabilityGraph/CurrentFrame";
export const CurrentFrame: Context.Reference<Frame | undefined> = Context.Reference(FRAME_KEY, {
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
  const references = new Map<Frame, Map<string, Reference>>();
  const loose = new Set<Frame>();
  /** Term id → what hosts it, where that was said and not built. */
  const hosting = new Map<string, string>();
  /** A value given out for a term → the term's id. */
  const standing = new WeakMap<object, string>();
  /** Term id → the bindings that are its resources. */
  const owned = new Map<string, Set<string>>();
  /** key → frames whose build produced it (several when two Layers
   *  provide one tag). */
  const providersByKey = new Map<string, Set<Frame>>();
  /** the produced service VALUE → its frame: disambiguates by identity
   *  when two Layers provide the same key. */
  const providersByValue = new WeakMap<object, Frame>();

  const isObject = (value: unknown): value is object =>
    (typeof value === "object" || typeof value === "function") && value !== null;

  /** Term id → the frames built under that name. */
  const named = new Map<string, Set<Frame>>();
  /** A frame, as the one provider of a value. */
  const alone = new Map<Frame, ReadonlySet<Frame>>();
  const NONE: ReadonlySet<Frame> = new Set();

  const providersOf = (key: string, value: unknown): ReadonlySet<Frame> => {
    if (isObject(value)) {
      const term = standing.get(value);
      if (term !== undefined) {
        const built = named.get(term);
        if (built !== undefined) return built;
      }
      const exact = providersByValue.get(value);
      if (exact !== undefined) {
        let only = alone.get(exact);
        if (only === undefined) alone.set(exact, (only = new Set([exact])));
        return only;
      }
    }
    return providersByKey.get(key) ?? NONE;
  };

  /**
   * A Layer reached through a lookup gives what its own build bound and
   * looked up. The Layers built inside it are not followed: a Layer that
   * composes others (`Layer.provideMerge`) has every one of them inside it,
   * and passes on services none of them made.
   */
  const collect = (
    frame: Frame,
    via: ReadonlyArray<string>,
    out: Map<string, Permission>,
    /** `2 * id` for a frame reached through a lookup, `2 * id + 1` for one entered. */
    visited: Set<number>,
    inside = true,
    /** Where to stop: another term, whose bindings are its own. */
    stop: (frame: Frame) => boolean = () => false,
  ): void => {
    if (stop(frame)) return;
    const entered = frame.id * 2 + 1;
    if (visited.has(entered) || (!inside && visited.has(entered - 1))) return;
    visited.add(inside ? entered : entered - 1);
    const bound = acquisitions.get(frame);
    if (bound !== undefined) {
      for (const [id, acquisition] of bound) {
        const existing = out.get(id);
        // keep the SHORTEST chain to each acquisition
        if (existing === undefined || existing.via.length > via.length) {
          out.set(id, { ...acquisition, via });
        }
      }
    }
    if (inside) {
      const built = children.get(frame);
      if (built !== undefined) {
        for (const child of built) collect(child, via, out, visited, true, stop);
      }
    }
    const looked = uses.get(frame);
    if (looked === undefined) return;
    for (const [key, value] of looked) {
      const providers = providersOf(key, value);
      if (providers.size === 0) continue;
      const through = [...via, key];
      for (const provider of providers) {
        collect(provider, through, out, visited, provider.kind !== "Layer", stop);
      }
    }
  };

  const closure = (
    roots: Iterable<Frame>,
    stop?: (frame: Frame) => boolean,
  ): ReadonlyArray<Permission> => {
    const out = new Map<string, Permission>();
    const visited = new Set<number>();
    for (const root of roots) collect(root, [], out, visited, true, stop);
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
      if (kind !== "Layer" && name !== undefined) {
        const id = `${kind}:${name}`;
        const built = named.get(id);
        if (built === undefined) named.set(id, new Set([frame]));
        else built.add(frame);
      }
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
    owns: (kind, name, resource) => {
      const id = `${kind}:${name}`;
      const set = owned.get(id);
      if (set === undefined) owned.set(id, new Set([resource]));
      else set.add(resource);
    },
    unhosted: (frame) => {
      loose.add(frame);
    },
    hosts: (kind, name, host) => {
      hosting.set(`${kind}:${name}`, host);
    },
    stands: (kind, name, value) => {
      if (isObject(value)) standing.set(value, `${kind}:${name}`);
    },
    refers: (frame, relation, kind, name) => {
      const reference = { relation, to: `${kind}:${name}` };
      const map = references.get(frame);
      const id = `${reference.relation}|${reference.to}`;
      if (map === undefined) references.set(frame, new Map([[id, reference]]));
      else map.set(id, reference);
    },
    describe: () => {
      const idOf = (frame: Frame) => `${frame.kind}:${frame.name}`;
      const isTerm = (frame: Frame) =>
        frame.kind !== "Layer" && frame.kind !== HOST && frame.name !== undefined;
      /** The terms a frame reaches by a lookup or by building them, without passing through another. */
      const reached = (root: Frame): ReadonlyArray<string> => {
        const out = new Set<string>();
        const self = idOf(root);
        const visited = new Set<number>([root.id * 2 + 1]);
        const step = (each: Frame, inside: boolean): void => {
          const entered = each.id * 2 + 1;
          if (visited.has(entered) || (!inside && visited.has(entered - 1))) return;
          visited.add(inside ? entered : entered - 1);
          if (isTerm(each)) {
            const id = idOf(each);
            if (id !== self) out.add(id);
          } else walk(each, inside);
        };
        const walk = (frame: Frame, inside: boolean): void => {
          if (inside) {
            const built = children.get(frame);
            if (built !== undefined) for (const each of built) step(each, true);
          }
          // As in `collect`: a Layer reached through a lookup is not entered.
          const looked = uses.get(frame);
          if (looked === undefined) return;
          for (const [key, value] of looked) {
            for (const each of providersOf(key, value)) step(each, false);
          }
        };
        walk(root, true);
        return [...out];
      };
      /** What hosts a frame: the nearest Host frame around it, or what was said to host a term around it. */
      const hostOf = (frame: Frame): string | undefined => {
        for (let each: Frame | undefined = frame; each !== undefined; each = each.parent) {
          if (each.kind === HOST) return each.name;
          const said = each.name === undefined ? undefined : hosting.get(idOf(each));
          if (said !== undefined) return said;
        }
        return undefined;
      };
      const byId = new Map<string, Array<Frame>>();
      for (const frame of frames.filter(isTerm)) {
        const group = byId.get(idOf(frame));
        if (group === undefined) byId.set(idOf(frame), [frame]);
        else group.push(frame);
      }
      const terms = new Map<string, Term>();
      /** Terms that have no host, whatever uses them. */
      const hostless = new Set<string>();
      for (const [id, group] of byId) {
        if (group.some((frame) => loose.has(frame))) hostless.add(id);
        const refs = new Map<string, Reference>();
        for (const frame of group) {
          for (const reference of references.get(frame)?.values() ?? []) {
            if (reference.to !== id) refs.set(`${reference.relation}|${reference.to}`, reference);
          }
        }
        const named = new Set([...refs.values()].map((reference) => reference.to));
        for (const to of group.flatMap(reached)) {
          if (!named.has(to)) refs.set(`uses|${to}`, { relation: "uses", to });
        }
        // What was said to host it holds, wherever its Layer was built.
        const host =
          hosting.get(id) ??
          (group.some((frame) => loose.has(frame))
            ? undefined
            : group.map(hostOf).find((each) => each !== undefined));
        terms.set(id, {
          id,
          kind: group[0]!.kind,
          name: group[0]!.name!,
          ...(host === undefined ? {} : { host }),
          bindings: closure(group, (frame) => isTerm(frame) && idOf(frame) !== id),
          references: [...refs.values()].sort((a, b) =>
            a.to !== b.to ? (a.to < b.to ? -1 : 1) : a.relation < b.relation ? -1 : 1,
          ),
        });
      }
      // A term built outside every host (a tool whose Layer the runtime
      // provides) is where the one host that uses it is.
      const users = new Map<string, Set<string>>();
      for (const term of terms.values()) {
        if (term.host === undefined) continue;
        for (const { to } of term.references) {
          const hosts = users.get(to);
          if (hosts === undefined) users.set(to, new Set([term.host]));
          else hosts.add(term.host);
        }
      }
      for (const [id, hosts] of users) {
        const term = terms.get(id);
        if (term === undefined || term.host !== undefined || hostless.has(id)) continue;
        if (hosts.size === 1) terms.set(id, { ...term, host: [...hosts][0]! });
      }
      // A term that is only referred to (a piece of a Domain model) has no
      // build of its own: it is a term all the same, so every reference resolves.
      for (const term of terms.values()) {
        for (const { to } of term.references) {
          if (terms.has(to)) continue;
          const at = to.indexOf(":");
          terms.set(to, {
            id: to,
            kind: to.slice(0, at),
            name: to.slice(at + 1),
            ...(term.host === undefined ? {} : { host: term.host }),
            bindings: [],
            references: [],
          });
        }
      }
      // A term known only by its resources (a Domain model) is a term too.
      for (const [id, resources] of owned) {
        const at = id.indexOf(":");
        const known = terms.get(id) ?? {
          id,
          kind: id.slice(0, at),
          name: id.slice(at + 1),
          bindings: [],
          references: [],
        };
        terms.set(id, { ...known, resources: [...resources].sort() });
      }
      return [...terms.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    ofService: (key) => closure(providersByKey.get(key) ?? []),
    frames: () => frames,
    reset: () => {
      nextId = 0;
      frames = [];
      children.clear();
      uses.clear();
      acquisitions.clear();
      references.clear();
      loose.clear();
      hosting.clear();
      owned.clear();
      providersByKey.clear();
      named.clear();
      alone.clear();
    },
  };
};

/**
 * The graph and the frame current on this fiber, read in one step.
 *
 * Every recorder below asks `globalThis.__ALCHEMY_RUNTIME__` before it calls
 * this, where the bundler can see it: in a deployed runtime the flag is
 * folded, and the recorder and what it would record are left out.
 */
const recording = <A, E, R>(
  otherwise: Effect.Effect<A, E, R>,
  record: (graph: CapabilityGraphShape, frame: Frame | undefined) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const graph = Context.getOrUndefined(fiber.context, CapabilityGraph);
    return graph === undefined ? otherwise : record(graph, fiber.getRef(CurrentFrame));
  });

/**
 * Run `effect` under a new named frame, a child of the current one:
 * `framed("Tool", name)(build)`. Without a graph in context it is `effect`.
 */
export const framed =
  (
    kind: NamedFrameKind,
    name: string,
    options?: {
      /**
       * `false` for a term that belongs to the runtime wherever its Layer
       * happens to be built first (a Domain model's policy): it has no host.
       */
      readonly hosted?: boolean;
    },
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    globalThis.__ALCHEMY_RUNTIME__
      ? effect
      : recording(effect, (graph, parent) => {
          // A host is built where it is first yielded, which says nothing of
          // what it belongs to: it starts a tree of its own.
          const frame = graph.frame(kind, name, kind === HOST ? undefined : parent);
          if (options?.hosted === false) graph.unhosted(frame);
          // What the term's build gives is the term: a lookup that receives it
          // (a tool's handler, through the Layer around it) reaches this frame.
          return Effect.tap(Effect.provideService(effect, CurrentFrame, frame), (made) =>
            Effect.sync(() => graph.provides(frame, new Map([[`${kind}:${name}`, made]]))),
          );
        });

/**
 * Record that the term being built uses another: `refer("uses", "Tool", name)`,
 * `refer("get", "Domain", "Board.IssueDetail")`. Outside a term, and without a
 * graph in context, it does nothing.
 */
export const refer = (relation: string, kind: string, name: string): Effect.Effect<void> =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : recording(Effect.void, (graph, frame) =>
        Effect.sync(() => {
          // The term around this point: Layers built inside it are passed over.
          let term = frame;
          while (term !== undefined && term.kind === "Layer") term = term.parent;
          if (term !== undefined && term.kind !== HOST) graph.refers(term, relation, kind, name);
        }),
      );

/**
 * Record that one of the runtime's bindings is a resource of a term:
 * `own("Model", "Board", "Board.IssueAggregate")`. Without a graph it does nothing.
 */
export const own = (kind: string, name: string, resource: string): Effect.Effect<void> =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : recording(Effect.void, (graph) => Effect.sync(() => graph.owns(kind, name, resource)));

/**
 * Record what hosts a term that is not built inside its host:
 * `hostedBy("Process", "Triage", "TriageProcess")`. The terms built inside
 * that term are hosted by it too. Without a graph it does nothing.
 */
export const hostedBy = (kind: string, name: string, host: string): Effect.Effect<void> =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : recording(Effect.void, (graph) => Effect.sync(() => graph.hosts(kind, name, host)));

/**
 * Record that `value` is given out for a term (a client to it): a lookup that
 * receives it uses the term. `standsFor("Process", "Triage", client)`.
 * Without a graph it does nothing.
 */
export const standsFor = (kind: string, name: string, value: unknown): Effect.Effect<void> =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : recording(Effect.void, (graph) => Effect.sync(() => graph.stands(kind, name, value)));

/**
 * Every binding a term reaches: its own, and those of every term it
 * references, however far. `via` starts with the terms passed through.
 */
export const reach = (terms: ReadonlyArray<Term>, id: string): ReadonlyArray<Permission> => {
  const byId = new Map(terms.map((term) => [term.id, term]));
  const out = new Map<string, Permission>();
  const visit = (at: string, through: ReadonlyArray<string>, seen: ReadonlySet<string>): void => {
    const term = byId.get(at);
    if (term === undefined || seen.has(at)) return;
    for (const binding of term.bindings) {
      const permission = { ...binding, via: [...through, ...binding.via] };
      const known = out.get(keyOf(permission));
      if (known === undefined || known.via.length > permission.via.length) {
        out.set(keyOf(permission), permission);
      }
    }
    for (const reference of term.references) {
      const next = byId.get(reference.to);
      if (next === undefined) continue;
      visit(reference.to, [...through, `${next.kind} ${next.name}`], new Set([...seen, at]));
    }
  };
  visit(id, [], new Set());
  return [...out.values()];
};

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
        return Effect.map(
          Effect.provideService(build(self, layerScope), CurrentFrame, frame),
          (out) => {
            const services = out.mapUnsafe;
            graph.provides(frame, services);
            const first = services.keys().next();
            if (!first.done) graph.label(frame, first.value);
            // A Layer this build made (`Layer.unwrap`) is built later, apart
            // from it. What that Layer provides was made here, with what
            // this build bound and looked up.
            let made = out;
            for (const [key, value] of services) {
              if (!Layer.isLayer(value)) continue;
              made = Context.makeUnsafe(
                new Map(made.mapUnsafe).set(
                  key,
                  Layer.fromBuild((memoMap, scope) =>
                    Effect.tap(
                      Effect.provideService(
                        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a Layer of any services: the map is generic over what it builds
                        Layer.buildWithMemoMap(value, memoMap, scope),
                        CurrentFrame,
                        frame,
                      ),
                      (built) => Effect.sync(() => graph.provides(frame, built.mapUnsafe)),
                    ),
                  ),
                ),
              );
            }
            return made;
          },
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

/**
 * A `ReadonlyMap` facade over a service map that reports every `get` to the
 * frame current in that map. One is made each time a fiber's context changes,
 * so it is two fields and a shared prototype.
 */
class RecordingMap {
  readonly [RECORDING] = true;
  readonly real: ReadonlyMap<string, unknown>;
  readonly graph: CapabilityGraphShape;
  constructor(real: ReadonlyMap<string, unknown>, graph: CapabilityGraphShape) {
    this.real = real;
    this.graph = graph;
  }
  get(key: string): unknown {
    const real = this.real;
    const value = real.get(key);
    // The frame lives in the same map (a Reference row).
    const frame = real.get(FRAME_KEY) as Frame | undefined;
    if (frame !== undefined) this.graph.uses(frame, key, value);
    return value;
  }
  has(key: string): boolean {
    return this.real.has(key);
  }
  get size(): number {
    return this.real.size;
  }
  forEach(
    f: (value: unknown, key: string, map: ReadonlyMap<string, unknown>) => void,
    thisArg?: unknown,
  ): void {
    this.real.forEach(f, thisArg);
  }
  keys() {
    return this.real.keys();
  }
  values() {
    return this.real.values();
  }
  entries() {
    return this.real.entries();
  }
  [Symbol.iterator]() {
    return this.real[Symbol.iterator]();
  }
}

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
      const inner = base.context;
      const tracer = Tracer.make({
        span: (options) => base.span(options),
        context: (primitive, fiber) => {
          try {
            const map = fiber.context.mapUnsafe;
            if (!(RECORDING in map)) {
              fiber.setContext(
                Context.makeUnsafe(
                  new RecordingMap(map, graph) as unknown as ReadonlyMap<string, unknown>,
                ),
              );
            }
          } catch {
            // degrade to an unobserved step
          }
          return inner !== undefined ? inner(primitive, fiber) : primitive[EVALUATE](fiber);
        },
      });
      return Effect.provideService(effect, Tracer.Tracer, tracer);
    });

/**
 * Record one capability acquisition under the current frame. Called by
 * `Binding.Service` on every bind of a plan; a no-op without a graph.
 */
export const recordAcquisition = (acquisition: Acquisition): Effect.Effect<void> =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : recording(Effect.void, (graph, frame) =>
        Effect.sync(() => {
          if (frame !== undefined) graph.acquires(frame, acquisition);
        }),
      );

/**
 * What each named term may use at runtime: the plan's list, as stored on the
 * runtime. `terms` maps `Kind:name` to indexes into `bindings`.
 */
export interface Policy {
  readonly bindings: ReadonlyArray<string>;
  readonly terms: { readonly [term: string]: ReadonlyArray<number> };
}

/** The env key a runtime's {@link Policy} is stored under. */
export const POLICY_KEY = "ALCHEMY_CAPABILITIES";

/** The {@link Policy} for what {@link CapabilityGraphShape.describe} gave. */
export const policyOf = (terms: ReadonlyArray<Term>): Policy => {
  const bindings: Array<string> = [];
  const index = new Map<string, number>();
  const held: { [term: string]: ReadonlyArray<number> } = {};
  for (const term of terms) {
    held[term.id] = term.bindings.map((permission) => {
      const key = keyOf(permission);
      let at = index.get(key);
      if (at === undefined) {
        at = bindings.push(key) - 1;
        index.set(key, at);
      }
      return at;
    });
  }
  return { bindings, terms: held };
};

/**
 * The policy in force. Set to try one without a deployed runtime; otherwise
 * it is read from the runtime's env, where the plan stored it.
 */
export const CurrentPolicy: Context.Reference<Policy | undefined> = Context.Reference(
  "alchemy/CapabilityGraph/CurrentPolicy",
  { defaultValue: (): Policy | undefined => undefined },
);

/** The named term running on this fiber: the tool whose handler is being called. */
export interface Caller {
  readonly kind: string;
  readonly name: string;
  /** `Kind:name`, as a {@link Policy} keys it. */
  readonly id: string;
}

export const CurrentCaller: Context.Reference<Caller | undefined> = Context.Reference(
  "alchemy/CapabilityGraph/CurrentCaller",
  { defaultValue: (): Caller | undefined => undefined },
);

/**
 * Run `effect` as a named term: `calling("Tool", name)(handler(parameters))`.
 * The bindings it uses are checked against what the plan listed under it.
 */
export const calling = (kind: NamedFrameKind, name: string) => {
  const caller: Caller = { kind, name, id: `${kind}:${name}` };
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentCaller, caller);
};

/** A term used a binding the plan does not list under it. */
export class CapabilityDenied extends Data.TaggedError("CapabilityDenied")<{
  /** The kind of term that made the call: `Tool`. */
  readonly kind: string;
  /** Its name. */
  readonly term: string;
  readonly binding: string;
  readonly targets: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** A policy as a bind reads it: for each binding, the terms that may use it. */
interface Held {
  readonly allowed: ReadonlyMap<string, ReadonlySet<string>>;
}
const NOBODY: ReadonlySet<string> = new Set();

const hold = (policy: Policy): Held => {
  const allowed = new Map<string, Set<string>>();
  for (const term in policy.terms) {
    for (const at of policy.terms[term]!) {
      const binding = policy.bindings[at]!;
      const terms = allowed.get(binding);
      if (terms === undefined) allowed.set(binding, new Set([term]));
      else terms.add(term);
    }
  }
  return { allowed };
};

/** What a policy holds, built once per policy. */
const helds = new WeakMap<Policy, Held>();
const heldOf = (policy: Policy): Held => {
  let held = helds.get(policy);
  if (held === undefined) helds.set(policy, (held = hold(policy)));
  return held;
};

/** The policy each runtime stored, read from its env once. `null`: it stored none. */
const stored = new WeakMap<object, Held | null>();

const parse = (raw: unknown): Held | null => {
  try {
    const policy =
      typeof raw === "string" ? (JSON.parse(raw) as Policy) : (raw as Policy | undefined);
    return policy === undefined || policy === null ? null : hold(policy);
  } catch {
    return null;
  }
};

/** `Stream`'s brand: checking it here keeps `effect/Stream` out of a runtime that has no streams. */
const STREAM_TYPE_ID = "~effect/Stream";

/** `client`, with every call it makes checked against the terms that may use the binding. */
const held = (
  binding: string,
  targets: ReadonlyArray<string>,
  allowed: ReadonlySet<string>,
  client: unknown,
): unknown => {
  const denied = (caller: Caller) => {
    const what = `${binding}${targets.length > 0 ? ` on ${targets.join(", ")}` : ""}`;
    return Effect.die(
      new CapabilityDenied({
        kind: caller.kind,
        term: caller.name,
        binding,
        targets,
        message: `${caller.kind} ${caller.name} used ${what}, which the plan does not list under it. Bind it where the ${caller.kind.toLowerCase()} is built.`,
      }),
    );
  };
  // One step in front of the client's own Effect: outside a term, and inside
  // one that may use the binding, it runs as it is.
  const checked = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) => {
      const caller = fiber.getRef(CurrentCaller);
      return caller === undefined || allowed.has(caller.id) ? effect : denied(caller);
    });
  const guard = (value: unknown): unknown => {
    if (Effect.isEffect(value)) return checked(value);
    if (typeof value === "object" && value !== null && STREAM_TYPE_ID in value) {
      // Checked when the stream is run, as an Effect is.
      return Stream.unwrap(
        checked(Effect.succeed(value as Stream.Stream<unknown, unknown, unknown>)),
      );
    }
    return value;
  };
  if (Effect.isEffect(client)) return guard(client);
  if (typeof client !== "function" && (typeof client !== "object" || client === null)) {
    return client;
  }
  if (STREAM_TYPE_ID in client) return guard(client);
  /** Each method, wrapped once. */
  const methods = new Map<string | symbol, { readonly from: unknown; readonly to: unknown }>();
  const member = (target: object, prop: string | symbol, receiver: unknown): unknown => {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") {
      if (typeof value !== "object" || value === null) return value;
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      // A frozen property must be returned as it is.
      return own !== undefined && !own.configurable && !own.writable ? value : guard(value);
    }
    const known = methods.get(prop);
    if (known !== undefined && known.from === value) return known.to;
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own !== undefined && !own.configurable && !own.writable) return value;
    const to = (...args: Array<unknown>) => guard(Reflect.apply(value, target, args));
    methods.set(prop, { from: value, to });
    return to;
  };
  return new Proxy(
    client,
    typeof client === "function"
      ? {
          apply: (target, thisArg, argArray) =>
            guard(Reflect.apply(target as (...args: Array<unknown>) => unknown, thisArg, argArray)),
          get: member,
        }
      : { get: member },
  );
};

/**
 * Hold a client a `Binding.Service` hands out to the policy in force: each
 * call it makes while a named term runs is checked. A runtime that stored no
 * policy (one with no named terms) gets the client as it is, after one step.
 */
export const guardClient = (
  binding: string,
  /** The bind's targets, worked out only when there is a policy to hold it to. */
  targets: () => ReadonlyArray<string>,
  client: unknown,
): Effect.Effect<unknown> =>
  Effect.withFiber((fiber) => {
    const apply = (policy: Held | null): unknown => {
      if (policy === null) return client;
      const over = targets();
      return held(
        binding,
        over,
        policy.allowed.get(keyOf({ binding, targets: over })) ?? NOBODY,
        client,
      );
    };
    const given = fiber.getRef(CurrentPolicy);
    if (given !== undefined) return Effect.succeed(apply(heldOf(given)));
    // Unbundled source is a plan: nothing is held to a policy while it is recorded.
    if (!globalThis.__ALCHEMY_RUNTIME__) return Effect.succeed(client);
    const runtime = Context.getOrUndefined(fiber.context, RuntimeContext);
    if (runtime === undefined) return Effect.succeed(client);
    const known = stored.get(runtime);
    if (known !== undefined) return Effect.succeed(apply(known));
    return Effect.map(runtime.get<string>(POLICY_KEY), (raw) => {
      const policy = parse(raw);
      stored.set(runtime, policy);
      return apply(policy);
    });
  });
