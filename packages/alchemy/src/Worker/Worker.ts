/**
 * The portable **`Alchemy.Worker`**: one authoring surface for
 * fetch-serving, Durable-Object-hosting workers. The definition is
 * cloud-free; the **deploy module** is the single line that names a
 * platform, and capability/platform mismatches surface as compile errors —
 * an unprovided requirement in the layer's `R`, not a deploy-time crash.
 *
 * ```ts
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export const ApiLive = Api.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 *
 * // the deploy module — swap the wrapper to switch clouds:
 * export default Cloudflare.Worker(Api, { main: import.meta.url }, ApiLive);
 * // export default Celld.Worker(Api, { fleet: Cells, main: import.meta.url }, ApiLive);
 * // export default Rivet.Worker(Api, { cluster: Actors, main: import.meta.url }, ApiLive);
 * ```
 *
 * The class is a pure TAG plus a `make` that packages the impl into a
 * deployable definition. There is no `Alchemy.Worker` resource type: the
 * deploy wrapper constructs its cloud's NATIVE worker resource from the
 * impl and provides this class's tag with that resource, so `yield* Api`
 * inside the stack resolves the native worker (URL and all).
 */
import type { DeploymentService, HostRef } from "./Engine.ts";
import type * as ConfigError from "effect/Config";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import type { HttpEffect } from "../Http.ts";
import type { Named, Tag } from "../Named.ts";
import type { MainRpc, PlatformServices } from "../Platform.ts";
import type { Resource } from "../Resource.ts";
import type { Rpc } from "../Rpc.ts";
import type { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import { Self } from "../Self.ts";
import type { WorkerBindingContract } from "./Engine.ts";

export const WorkerTypeId = "Alchemy.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

/**
 * The portable worker contract — the attribute surface every deploy
 * target's native worker resource satisfies. Purely type-level: the value
 * behind the tag is the NATIVE resource (Cloudflare / Celld / Rivet
 * worker), which carries strictly more.
 */
export interface Worker extends Resource<
  WorkerTypeId,
  {},
  {
    /** The worker's reachable URL, when the platform exposes one. */
    url: string | undefined;
  },
  WorkerBindingContract
> {}

/** Services available to a worker impl's init effect. */
export type WorkerServices = Worker | WorkerEnvironment;

/** The impl shape of a worker: an optional `fetch` handler + RPC methods. */
export type WorkerShape =
  | void
  | ({ fetch?: HttpEffect<any> } & Partial<MainRpc<never>>);

export const WorkerDefinitionTag = "Alchemy.WorkerDefinition" as const;

/**
 * The deployable definition `Worker.make(impl)` produces: a runtime-inert
 * marker carrying the impl, typed as the layer the deploy wrapper will
 * actually produce. Only deploy wrappers consume it — building it
 * directly dies with guidance.
 */
export interface WorkerDefinition {
  readonly _tag: typeof WorkerDefinitionTag;
  readonly impl: Effect.Effect<any, any, any>;
}

export const isWorkerDefinition = (value: unknown): value is WorkerDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === WorkerDefinitionTag;

export interface WorkerClass {
  <Self, Shape = never>(): {
    /**
     * Inline form: the deployable class in one declaration — the impl
     * (carrying its capability layers in its own provide chain) sits
     * right on the class; the deploy wrapper picks it up.
     */
    <
      const Id extends string,
      ImplShape extends ([Shape] extends [never] ? WorkerShape : Shape),
      Req extends
        | WorkerServices
        | PlatformServices
        | HostRef
        | DeploymentService<any, string> = never,
    >(
      id: Id,
      impl: Effect.Effect<ImplShape, ConfigError.ConfigError, Req>,
    ): Effect.Effect<
      Worker & Rpc<Self>,
      never,
      Extract<Req, HostRef | DeploymentService<any, string>>
    > &
      Named<Id> & {
        new (
          _: never,
        ): ([Shape] extends [never] ? ImplShape : Shape) &
          Named<Id> &
          Tag<WorkerTypeId>;
      };
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<Worker & Rpc<Self>, never, never> &
      Named<Id> & {
        /**
         * The deployable definition: the impl carries its own capability
         * layers in one provide chain; the deploy wrapper
         * (`Cloudflare.Worker(cls, props, definition)`) supplies the
         * platform.
         */
        make<
          Req extends
            | WorkerServices
            | PlatformServices
            | HostRef
            | DeploymentService<any, string> = never,
        >(
          impl: Effect.Effect<
            [Shape] extends [never] ? WorkerShape : Shape,
            ConfigError.ConfigError,
            Req
          >,
        ): Layer.Layer<
          Self,
          never,
          Extract<Req, HostRef | DeploymentService<any, string>>
        >;
        new (
          _: never,
        ): ([Shape] extends [never] ? {} : Shape) &
          Named<Id> &
          Tag<WorkerTypeId>;
      };
  };
}

/** The keyed Self tag a deploy wrapper provides with the native resource. */
export const workerSelf = (logicalId: string) =>
  Self(`${WorkerTypeId}<${logicalId}>`);

const makeDefinition = (impl: Effect.Effect<any, any, any>, tag: any) =>
  Object.assign(
    Layer.effect(
      tag,
      Effect.die(
        new Error(
          "An Alchemy.Worker definition cannot be built directly — deploy " +
            "it through a cloud wrapper, e.g. " +
            "`Cloudflare.Worker(Api, { main: import.meta.url }, ApiLive)` " +
            "(or Celld.Worker / Rivet.Worker).",
        ),
      ),
    ),
    { _tag: WorkerDefinitionTag, impl },
  );

const makeWorkerClass = (
  id: string,
  inlineImpl?: Effect.Effect<any, any, any>,
): any => {
  const tag = workerSelf(id);
  class PortableWorker {
    /** Logical id of the worker this class names. Statically readable. */
    static readonly LogicalId = id;
    /** The Context tag the deploy wrapper provides the native resource under. */
    static readonly Self = tag;
    /** Inline-form impl, when the class was declared with one. @internal */
    static readonly impl = inlineImpl;
    static make = (impl: Effect.Effect<any, any, any>) =>
      makeDefinition(impl, tag);
  }
  // Make the class a real Effect: `yield* Api` resolves the tag — the
  // deploy wrapper's layer provides it with the native worker resource.
  return Object.assign(
    PortableWorker,
    Effectable.Prototype({
      label: `${WorkerTypeId}<${id}>`,
      evaluate: () => tag,
    }),
  );
};

const workerConstructor = (...args: any[]): any => {
  if (args.length === 0) {
    return (id: string, impl?: unknown) =>
      makeWorkerClass(
        id,
        Effect.isEffect(impl) ? (impl as Effect.Effect<any>) : undefined,
      );
  }
  return makeWorkerClass(
    args[0] as string,
    Effect.isEffect(args[1]) ? (args[1] as Effect.Effect<any>) : undefined,
  );
};

export const Worker: WorkerClass = workerConstructor as any;
