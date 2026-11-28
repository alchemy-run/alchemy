/**
 * Objects on Cloudflare: `alchemy/Workers/ObjectHost` on a Worker's Durable
 * Objects, which Domain's models and AI's sessions are built on.
 *
 * @module
 */
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  type DeclareOptions,
  type Namespace,
  type ObjectImpl,
  ObjectHost,
  ObjectState,
  type ObjectStateShape,
  type Stub,
} from "alchemy/Workers/ObjectHost";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { DurableObjectCallbacks, outsideAlarmPass } from "./AlarmCallback.ts";
import {
  DurableObject,
  type DurableObjectGetDurableObjectOptions,
  type DurableObjectJurisdiction,
  type DurableObjectLocationHint,
  type InlineDurableObjectProps,
} from "./DurableObject.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { makeRpcStub } from "./Rpc.ts";
import { upgrade } from "./WebSocket.ts";
import type { Worker } from "./Worker.ts";
import { WorkerEnvironment } from "./WorkerRuntime.ts";

/** A Durable Object namespace of hosted objects: the contract's, plus fetch and jurisdictions. */
export interface DurableObjectHostNamespace {
  readonly getByName: (
    name: string,
    options?: DurableObjectGetDurableObjectOptions,
  ) => Stub & {
    readonly fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
  };
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => DurableObjectHostNamespace;
}

/** A hosted object as a Durable Object runs it: the outer (construction) / inner (instance) pair. */
export type DurableObjectHostImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, DurableObjectState | RuntimeContext | Scope.Scope>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a Layer.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
export const declareHostClass = DurableObject as unknown as (
  name: string,
  props: InlineDurableObjectProps,
  impl: DurableObjectHostImpl,
) => Effect.Effect<DurableObjectHostNamespace, never, Worker>;

/** An object's state over a Cloudflare Durable Object's. */
export const hostObjectState = (
  state: DurableObjectState["Service"],
  runtime: RuntimeContext["Service"],
): ObjectStateShape => ({
  storage: state.storage as unknown as ObjectStateShape["storage"],
  // Durable Objects run each event in its own I/O context, so in-memory
  // coordination across events is unsafe; the platform's gate is not.
  exclusive: (effect) =>
    Effect.flatMap(
      state.blockConcurrencyWhile(() => Effect.exit(effect)),
      (exit) => exit,
    ).pipe(Effect.provideService(RuntimeContext, runtime)),
  // Background work outside the alarm pass, so a callback's alarm isn't held open by it.
  waitUntil: (effect) =>
    state.waitUntil(outsideAlarmPass(effect)).pipe(Effect.provideService(RuntimeContext, runtime)),
  sockets: {
    accept: () =>
      Effect.provideService(upgrade(), DurableObjectState, state) as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["accept"]
      >,
    all: () =>
      state.getWebSockets() as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["all"]
      >,
  },
});

/** Run an object on a Cloudflare Durable Object class. */
export const onDurableObject = (impl: ObjectImpl): DurableObjectHostImpl =>
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const runtime = yield* RuntimeContext;
      return yield* impl.pipe(
        Effect.provideService(ObjectState, hostObjectState(state, runtime)),
        Effect.provide(DurableObjectCallbacks),
      );
    }),
  );

/** Where Cloudflare keeps a host's Durable Objects. */
export interface ObjectPlacement {
  /**
   * Create and store every object only inside this jurisdiction, e.g.
   * `"eu"`. An object in a jurisdiction is a different object from the one
   * with the same name outside it, so choose it before the first deploy.
   *
   * @default undefined (no jurisdiction restriction)
   */
  readonly jurisdiction?: DurableObjectJurisdiction | undefined;
  /**
   * Create every new object near this location, e.g. `"wnam"`, instead of
   * near the Worker that first reaches it. An object stays where it was
   * created.
   *
   * @default undefined (each object is created near its first request)
   */
  readonly locationHint?: DurableObjectLocationHint | undefined;
}

/** A namespace that creates each new object near `locationHint`. */
const hinted = (
  namespace: DurableObjectHostNamespace,
  locationHint: DurableObjectLocationHint,
): DurableObjectHostNamespace => ({
  ...namespace,
  getByName: (name, options) => namespace.getByName(name, { locationHint, ...options }),
  jurisdiction: (inside) => hinted(namespace.jurisdiction(inside), locationHint),
});

/**
 * A namespace whose objects live in the placement's jurisdiction and are
 * created near its location hint.
 */
export const placeObjects = (
  namespace: DurableObjectHostNamespace,
  placement: ObjectPlacement,
): DurableObjectHostNamespace => {
  const inside =
    placement.jurisdiction === undefined
      ? namespace
      : namespace.jurisdiction(placement.jurisdiction);
  return placement.locationHint === undefined ? inside : hinted(inside, placement.locationHint);
};

/** A Durable Object namespace from a Worker's bindings, placed. */
export const namespaceFromBinding = (
  native: any,
  placement: ObjectPlacement,
): DurableObjectHostNamespace => {
  const wrap = (namespace: any): DurableObjectHostNamespace => ({
    getByName: (name, options) => makeRpcStub(namespace.getByName(name, options)) as never,
    jurisdiction: (inside) => wrap(namespace.jurisdiction(inside)),
  });
  return placeObjects(wrap(native), placement);
};

/** Options for {@link layerObjectHost}. */
export interface ObjectHostOptions extends ObjectPlacement {}

/**
 * Objects on Cloudflare. Every class declared on it is a Durable Object
 * class of the Worker that provides the Layer, and each object is one
 * Durable Object, with its own storage and alarm.
 *
 * `@alchemy.run/ai/Cloudflare` is built on it. Provide it yourself only to
 * put something of your own on the same contract.
 *
 * **Example:** Objects kept in the EU
 * ```typescript
 * const Objects = Cloudflare.layerObjectHost({ jurisdiction: "eu" });
 * ```
 *
 * @layer
 * @provides ObjectHost
 */
export const layerObjectHost = (
  options: ObjectHostOptions = {},
): Layer.Layer<ObjectHost, never, Worker> =>
  Layer.effect(
    ObjectHost,
    Effect.gen(function* () {
      // The Worker the classes are declared on: this Layer's.
      const worker = yield* Effect.context<Worker>();
      // The Worker's bindings, at runtime: see `lookup`.
      const env = Option.getOrUndefined(yield* Effect.serviceOption(WorkerEnvironment));
      return ObjectHost.of({
        declare: (name: string, impl: ObjectImpl, declared?: DeclareOptions) =>
          declareHostClass(
            name,
            declared?.renamedFrom === undefined ? {} : { renamedFrom: declared.renamedFrom },
            onDurableObject(impl),
          ).pipe(
            Effect.map((namespace): Namespace => placeObjects(namespace, options)),
            Effect.provideContext(worker),
          ),
        lookup: (name) => {
          const namespace = (env as Record<string, any> | undefined)?.[name];
          return namespace !== undefined && typeof namespace.getByName === "function"
            ? namespaceFromBinding(namespace, options)
            : undefined;
        },
      });
    }),
  );
