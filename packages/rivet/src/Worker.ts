import type { HttpEffect } from "alchemy/Http";
import type { Main, MainRpc, PlatformProps } from "alchemy/Platform";
import { Platform } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { serveRpc } from "alchemy/Rpc";
import { createContainerRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import type { Self } from "alchemy/Self";
import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import type { WorkerEnvironment } from "alchemy/Workers/Worker";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableObjectBinding, durableObjectStub } from "./DurableObject.ts";
import { makeWorkerEnvironment, runDurableObjects } from "./internal/Runtime.ts";
import type { Providers } from "./Providers.ts";

export const RivetWorkerTypeId = "Rivet.Worker";
export type RivetWorkerTypeId = typeof RivetWorkerTypeId;

type WorkerServices = RivetWorker | Providers | WorkerEnvironment | Self | Self<RivetWorker>;
type WorkerShape = Main<WorkerServices> & MainRpc<WorkerServices>;

export interface RivetWorkerProps extends PlatformProps {
  /** The module that exports this Worker, usually `import.meta.url`. */
  main: string;
  /**
   * The export of {@link main} that holds this Worker.
   * @default "default"
   */
  handler?: string;
}

export interface RivetWorkerAttributes {
  /** Where the Worker serves HTTP, as reported by its host. */
  url: string | undefined;
  /** The Durable Object classes this Worker hosts. */
  durableObjects: string[];
}

/** Data a host and the Worker's Durable Objects bind onto the Worker. */
export interface RivetWorkerBindingContract {
  /** Where the host serves the Worker. */
  url?: string;
  /** Durable Object classes the Worker hosts. */
  durableObjects?: { name: string; className: string }[];
}

export interface RivetWorker extends Resource<
  RivetWorkerTypeId,
  RivetWorkerProps,
  RivetWorkerAttributes,
  RivetWorkerBindingContract,
  Providers
> {}

/** The Worker was deployed without a host Layer, so nothing would run it. */
export class WorkerHasNoHost extends Data.TaggedError("Rivet.WorkerHasNoHost")<{
  readonly message: string;
}> {}

export interface RivetWorkerRuntimeContext extends HostRuntimeContext {
  readonly Type: RivetWorkerTypeId;
  readonly alwaysServe: true;
  readonly hostServices: Layer.Layer<WorkerEnvironment>;
  /** Register a Durable Object class this Worker hosts. */
  readonly export: (name: string, value: DurableObjectExport) => Effect.Effect<void>;
  readonly durableObjectBinding: typeof durableObjectBinding;
  readonly durableObjectStub: typeof durableObjectStub;
  /**
   * Called by a host Layer while the Worker's Effect runs: `deploy` declares
   * the resources that run the Worker, once its bindings are all collected.
   * @internal
   */
  readonly registerHost: (deploy: Effect.Effect<void, never, any>) => Effect.Effect<void>;
}

const createRuntimeContext = (id: string): RivetWorkerRuntimeContext => {
  const base = createContainerRuntimeContext(RivetWorkerTypeId)(id);
  const durableObjects = new Map<string, DurableObjectExport>();
  let deploy: Effect.Effect<void, never, any> | undefined;

  const ctx: RivetWorkerRuntimeContext = {
    ...base,
    Type: RivetWorkerTypeId,
    alwaysServe: true,
    // Durable Object namespaces resolve through the control plane's gateway.
    hostServices: Layer.succeedContext(makeWorkerEnvironment()),
    export: (name, value) => Effect.sync(() => void durableObjects.set(name, value)),
    durableObjectBinding,
    durableObjectStub,
    registerHost: (next) =>
      Effect.sync(() => {
        deploy = next;
      }),
    serve: <Req = never>(
      handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
      options?: { shape?: Record<string, unknown> },
    ) =>
      Effect.gen(function* () {
        // The Worker's RPC methods are served under `/__rpc__/{method}`
        // ahead of its own `fetch`.
        yield* base.serve(serveRpc(options?.shape ?? {}, handler as HttpEffect<Req>), options);
        if (globalThis.__ALCHEMY_RUNTIME__) {
          // The nodes host the Worker's Durable Objects as Rivet actors.
          yield* base.run(runDurableObjects(durableObjects, ctx));
          return;
        }
        // Every binding has been collected by now: hand the Worker to its host.
        if (deploy === undefined) {
          return yield* Effect.die(
            new WorkerHasNoHost({
              message:
                `Rivet.Worker '${id}' has no host. Provide a host Layer to its Effect, ` +
                `for example RivetDocker.Service() or RivetAWS.EcsService().`,
            }),
          );
        }
        yield* deploy;
      }),
  };
  return ctx;
};

/**
 * The class surface of {@link Worker}: the native Platform forms
 * (`Rivet.Worker("Id", props, impl)`, and the `<Self>()` class forms with
 * `.make(props, impl)`).
 */
export type RivetWorkerClass = Platform<
  RivetWorker,
  WorkerServices,
  WorkerShape,
  RivetWorkerRuntimeContext,
  {},
  RivetWorkerProps
>;

/**
 * A **Rivet Worker**: an Effect program with a `fetch` handler that runs as
 * a node of a Rivet control plane and hosts the `Rivet.DurableObject`
 * classes it implements as Rivet actors.
 *
 * Where it runs is a host Layer provided to the Worker's Effect, and the
 * host is given the control plane: `RivetDocker.Service()` on a Docker
 * swarm, `RivetAWS.EcsService()` on ECS. Every Worker is its own service
 * with its own nodes, and any number of Workers share one control plane.
 *
 * ### Deploying a Worker
 * **Example:** A Worker that hosts a Durable Object
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 *
 * export class Api extends Rivet.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const count = yield* counters.getByName("visits").increment();
 *         return HttpServerResponse.text(String(count));
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(CounterLive, RivetDocker.Service({ port: 8080 }).pipe(Layer.provide(Cluster))),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @resource
 * @product Rivet
 */
export const Worker: RivetWorkerClass = Platform(RivetWorkerTypeId, {
  createRuntimeContext,
}) as RivetWorkerClass;

export const WorkerProvider = () =>
  Provider.succeed(Worker, {
    stables: ["durableObjects"],
    reconcile: ({ bindings }) =>
      Effect.sync(() => {
        let url: string | undefined;
        const durableObjects: string[] = [];
        for (const binding of bindings) {
          const data = binding.data;
          if (data.url !== undefined) url = data.url;
          for (const object of data.durableObjects ?? []) durableObjects.push(object.name);
        }
        return { url, durableObjects };
      }),
    delete: () => Effect.void,
  });
