/**
 * The node side of a pool: host each `Rivet.DurableObject` class the node
 * was built with as a RivetKit actor.
 *
 * RivetKit is imported lazily: it loads a native addon.
 *
 * @internal
 */
import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "alchemy/Workers/DurableObjectBridge";
import type { WorkerBuild } from "alchemy/Workers/Worker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { HostedDurableObject } from "../DurableObject.ts";
import {
  ALARM_ACTION,
  DurableObjectState,
  clearFiredAlarm,
  makeDurableObjectState,
  migrateStorage,
  type ActorContextLike,
} from "../DurableObjectState.ts";

/** Read a RivetKit setting the pool put in the node's environment. */
const env = (name: string): string | undefined => process.env[name];

/** Serve one actor request through the instance's `fetch` (and fetch-RPC). */
const handleRequest = (instance: DurableObjectInstance, request: Request) =>
  instance.execute(
    (shape) =>
      Effect.gen(function* () {
        const response = yield* instance
          .fetch(shape, request)
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
          );
        return HttpServerResponse.toWeb(response);
      }),
    async (exit) =>
      Exit.isSuccess(exit)
        ? (exit.value as Response)
        : new Response("Internal Server Error", { status: 500 }),
  );

/**
 * Host every Durable Object class as a RivetKit actor and connect this node
 * to the control plane. Runs for the life of the node.
 */
export const runDurableObjects = (durableObjects: ReadonlyArray<HostedDurableObject>) =>
  Effect.gen(function* () {
    if (durableObjects.length === 0) return yield* Effect.never;
    const { actor, setup } = yield* Effect.promise(() => import("rivetkit"));
    const { db } = yield* Effect.promise(() => import("rivetkit/db"));

    const use: Record<string, unknown> = {};
    for (const hosted of durableObjects) {
      const name = hosted.name;
      const build: WorkerBuild<DurableObjectExport, unknown> = {
        // The services the class phase ran with.
        context: hosted.context as Context.Context<any>,
        runtimeContext: hosted.runtime,
        // The class phase has already run: its result is the instance constructor.
        export: {
          kind: "durableObject",
          constructor: Effect.succeed(hosted.instance),
          services: hosted.context,
        },
        shape: () => ({}),
        telemetry: () => undefined,
      };
      // One instance per actor activation, built on first use.
      const instances = new WeakMap<object, DurableObjectInstance>();
      const instanceOf = (c: ActorContextLike) => {
        let instance = instances.get(c);
        if (instance === undefined) {
          instance = makeDurableObjectInstance({
            build: () => Promise.resolve(build),
            services: Context.make(DurableObjectState, makeDurableObjectState(c)),
            waitUntil: (promise) => c.waitUntil(promise),
            // RPC arrives as fetch-RPC over the actor's `fetch`.
            dispatch: "static",
          });
          instances.set(c, instance);
        }
        return instance;
      };

      use[name] = actor({
        db: db({ onMigrate: (database) => migrateStorage(database) }),
        onRequest: (c: ActorContextLike, request: Request) => handleRequest(instanceOf(c), request),
        actions: {
          [ALARM_ACTION]: (c: ActorContextLike) =>
            instanceOf(c).execute((shape) =>
              clearFiredAlarm(c).pipe(
                Effect.andThen(
                  typeof shape.alarm === "function"
                    ? (shape.alarm as () => Effect.Effect<void>)()
                    : Effect.void,
                ),
              ),
            ),
        },
      } as never);
    }

    const registry = setup({
      use,
      endpoint: env("RIVET_ENDPOINT"),
      token: env("RIVET_TOKEN"),
      namespace: env("RIVET_NAMESPACE"),
      envoy: { poolName: env("RIVET_POOL") },
      noWelcome: true,
    } as never) as { startAndWait(): Promise<void>; shutdown(): Promise<void> };

    yield* Effect.promise(() => registry.startAndWait());
    yield* Effect.logInfo(
      `Rivet node connected: ${durableObjects.map((hosted) => hosted.name).join(", ")}`,
    );
    return yield* Effect.never.pipe(Effect.ensuring(Effect.promise(() => registry.shutdown())));
  });
