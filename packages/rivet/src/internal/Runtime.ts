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
import { InputGateLive } from "alchemy/Workers/InputGate";
import type { WorkerBuild } from "alchemy/Workers/Worker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type { HostedDurableObject } from "../DurableObject.ts";
import {
  ALARM_ACTION,
  DurableObjectState,
  claimFiredAlarm,
  makeDurableObjectState,
  migrateStorage,
  type ActorContextLike,
} from "../DurableObjectState.ts";

/** What an actor activation keeps in memory until it sleeps. */
interface ActivationVars {
  instance: DurableObjectInstance | undefined;
}

type ActivationContext = ActorContextLike & { readonly vars: ActivationVars };

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
    const context = yield* Effect.context<never>();
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
      // One instance per actor activation, built on its first call. RivetKit
      // hands every request its own context object, so the instance lives
      // in the activation's vars, which last until the actor sleeps.
      const instanceOf = (c: ActivationContext) => {
        let instance = c.vars.instance;
        if (instance === undefined) {
          instance = makeDurableObjectInstance({
            build: () => Promise.resolve(build),
            // RivetKit runs an actor's calls concurrently over async
            // storage: the instance's own input gate keeps one call's
            // storage from interleaving with another's.
            services: Context.add(
              Effect.runSyncWith(context)(InputGateLive.pipe(Layer.build, Effect.scoped)),
              DurableObjectState,
              makeDurableObjectState(c),
            ),
            waitUntil: (promise) => c.waitUntil(promise),
            // RPC arrives as fetch-RPC over the actor's `fetch`.
            dispatch: "static",
          });
          c.vars.instance = instance;
        }
        return instance;
      };

      use[name] = actor({
        db: db({ onMigrate: (database) => migrateStorage(database) }),
        createVars: (): ActivationVars => ({ instance: undefined }),
        onRequest: (c: ActivationContext, request: Request) =>
          handleRequest(instanceOf(c), request),
        actions: {
          [ALARM_ACTION]: (c: ActivationContext, token: unknown) =>
            instanceOf(c).execute((shape) =>
              claimFiredAlarm(c, token).pipe(
                Effect.flatMap((current) =>
                  current && typeof shape.alarm === "function"
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
