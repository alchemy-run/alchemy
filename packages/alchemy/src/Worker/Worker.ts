/**
 * The portable **`Alchemy.Worker`**: one authoring surface for
 * fetch-serving, Durable-Object-hosting workers, with the deployment
 * platform selected by a **target layer inside the impl's own provide
 * chain** — so capability/engine mismatches surface as compile errors at
 * `Api.make(impl)`, not at deploy time.
 *
 * ```ts
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export default Api.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(
 *     Effect.provide(
 *       CounterLive.pipe(
 *         Layer.provideMerge(Celld.Worker({ fleet: Cells, main: import.meta.url })),
 *       ),
 *     ),
 *   ),
 * );
 * ```
 *
 * The target layer records itself on the worker's runtime context; the
 * platform folds it into the persisted Props, and the provider dispatches
 * every lifecycle operation to the matching {@link WorkerEngine}
 * (`Celld.providers()` registers `celld`; a Cloudflare engine slots in the
 * same way).
 */
import type { DeploymentService, HostRef } from "./Engine.ts";
import type * as ConfigError from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HttpEffect } from "../Http.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import type { MainRpc, PlatformServices } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import {
  Resource,
  isResourceOfType,
  type ResourceBinding,
} from "../Resource.ts";
import type { Rpc } from "../Rpc.ts";
import type { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import {
  findWorkerEngine,
  type WorkerBindingContract,
  type WorkerTargetService,
} from "./Engine.ts";
import { makeGenericWorkerRuntimeContext } from "./RuntimeContext.ts";
import type { Providers } from "./Providers.ts";

export const WorkerTypeId = "Alchemy.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

export interface WorkerProps extends PlatformProps {
  /** Extra environment variables for the worker. */
  env?: Record<string, any>;
  /**
   * Deployment target — stamped by the target layer provided inside the
   * impl (via the runtime context's `foldProps`); never set manually.
   * @internal
   */
  target?: { kind: string; props: Record<string, unknown> };
  /**
   * Durable Object / export map. Populated automatically from the impl;
   * do not set manually.
   * @internal
   */
  exports?: Record<string, any>;
}

export interface Worker extends Resource<
  WorkerTypeId,
  WorkerProps,
  {
    /** The engine kind this worker deployed through. */
    targetKind: string;
    /** The worker's reachable URL, when the engine exposes one. */
    url: string | undefined;
    /** Engine-specific attributes, as returned by the engine's reconcile. */
    engine: Record<string, any>;
  },
  WorkerBindingContract,
  Providers
> {}

export const isAlchemyWorker = <T>(value: T): value is T & Worker =>
  isResourceOfType(value, WorkerTypeId);

/** Services available to a worker impl's init effect. */
export type WorkerServices = Worker | WorkerEnvironment;

/** The impl shape of a worker: an optional `fetch` handler + RPC methods. */
export type WorkerShape =
  | void
  | ({ fetch?: HttpEffect<any> } & Partial<MainRpc<never>>);

export interface WorkerClass extends Effect.Effect<Worker, never, Worker> {
  <Self, Shape = never>(): {
    /**
     * Inline form: the deployable class in one declaration — the impl
     * (carrying its capability layers and deployment target in its own
     * provide chain) sits right on the class.
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
      Providers | Extract<Req, HostRef | DeploymentService<any, string>>
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
    ): Effect.Effect<Worker & Rpc<Self>, never, Providers> &
      Named<Id> & {
        /**
         * The deployable module: the impl carries its own capability
         * layers AND its deployment target in one provide chain.
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
          Providers | Extract<Req, HostRef | DeploymentService<any, string>>
        >;
        new (
          _: never,
        ): ([Shape] extends [never] ? {} : Shape) &
          Named<Id> &
          Tag<WorkerTypeId>;
      };
  };
}

const platform = Platform(WorkerTypeId, {
  createRuntimeContext: makeGenericWorkerRuntimeContext,
});

const workerConstructor = (...args: any[]): any => {
  if (args.length === 0) {
    const tagged = (platform as any)();
    return (id: string, impl?: unknown) => {
      if (Effect.isEffect(impl)) {
        // Inline form: the class IS the deployable — props are empty; the
        // deployment target arrives via the impl's own provide chain.
        return tagged(id, {}, impl);
      }
      const cls = tagged(id);
      // The portable surface takes the impl ONLY — deployment config
      // arrives via the target layer inside the impl's provide chain.
      const platformMake = cls.make;
      cls.make = (implOnly: unknown) => platformMake.call(cls, {}, implOnly);
      return cls;
    };
  }
  return (platform as any)(...args);
};

export const Worker: WorkerClass = Object.assign(
  workerConstructor,
  platform,
) as any;

export const WorkerProvider = () =>
  Provider.effect(
    Worker as any,
    Effect.gen(function* () {
      return {
        read: ({ output }: { output: Record<string, any> | undefined }) =>
          Effect.succeed(output),

        diff: ({
          id,
          news,
          output,
        }: {
          id: string;
          news: any;
          output: Record<string, any> | undefined;
        }) =>
          Effect.gen(function* () {
            const kind: string | undefined = news?.target?.kind;
            if (kind === undefined || output === undefined) {
              return undefined;
            }
            const engine = yield* findWorkerEngine(kind);
            return engine.diff
              ? yield* engine.diff({ id, news, output: output?.engine })
              : undefined;
          }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          session,
          bindings,
        }: {
          id: string;
          news: WorkerProps;
          olds: WorkerProps | undefined;
          output: Record<string, any> | undefined;
          session: { note: (message: string) => Effect.Effect<void> };
          bindings: ResourceBinding<WorkerBindingContract>[];
        }) {
          const engine = yield* findWorkerEngine(news.target?.kind);
          const attributes = yield* engine.reconcile({
            id,
            news: news as Record<string, any>,
            olds: olds as Record<string, any> | undefined,
            // Engines see their own attribute bag.
            output: output?.engine,
            session,
            bindings,
          });
          return {
            targetKind: news.target!.kind,
            url: (attributes as { url?: string }).url,
            engine: attributes,
          };
        }),

        delete: Effect.fn(function* ({
          id,
          olds,
          output,
        }: {
          id: string;
          olds: WorkerProps;
          output: Record<string, any>;
        }) {
          const kind: string | undefined =
            output?.targetKind ?? olds?.target?.kind;
          if (kind === undefined) {
            return;
          }
          const engine = yield* findWorkerEngine(kind);
          yield* engine.delete({
            id,
            olds: olds as Record<string, any>,
            output: output?.engine ?? output,
          });
        }),
      };
    }),
  );
