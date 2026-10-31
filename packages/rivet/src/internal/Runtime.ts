/**
 * The node side of a `Rivet.Worker`: host each Durable Object class the
 * Worker exports as a RivetKit actor, and give the Worker's code a
 * `WorkerEnvironment` whose entries address actors through the control
 * plane's gateway.
 *
 * RivetKit is imported lazily: it loads a native addon, and this module is
 * part of every Worker bundle and of the deploy-time program.
 *
 * @internal
 */
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "alchemy/Workers/DurableObjectBridge";
import { WorkerEnvironment, type WorkerBuild } from "alchemy/Workers/Worker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  ALARM_ACTION,
  DurableObjectState,
  clearFiredAlarm,
  makeDurableObjectState,
  migrateStorage,
  type ActorContextLike,
} from "../DurableObjectState.ts";

/** Read a RivetKit setting the host put in the node's environment. */
const env = (name: string): string | undefined => process.env[name];

/** One RivetKit client per node, shared by every namespace. */
let client: Promise<Record<string, { getOrCreate: Function }>> | undefined;
const getClient = () =>
  (client ??= import("rivetkit/client").then(
    ({ createClient }) =>
      createClient({
        endpoint: env("RIVET_ENDPOINT"),
        token: env("RIVET_TOKEN"),
        namespace: env("RIVET_NAMESPACE"),
      } as never) as unknown as Record<string, { getOrCreate: Function }>,
  ));

/**
 * The Worker's runtime environment: every Durable Object name resolves to a
 * namespace whose stubs fetch the actor through the gateway. The actor runs
 * in this Worker's own pool.
 */
export const makeWorkerEnvironment = () =>
  Context.make(
    WorkerEnvironment,
    new Proxy({} as Record<string, unknown>, {
      get: (_target, name) =>
        typeof name !== "string"
          ? undefined
          : {
              getByName: (key: string) => ({
                fetch: async (input: Request | string | URL, init?: RequestInit) => {
                  const actors = await getClient();
                  const handle = actors[name]!.getOrCreate([key], {
                    poolName: env("RIVET_POOL"),
                  }) as {
                    fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
                  };
                  return handle.fetch(input, init);
                },
              }),
            },
    }),
  );

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
 * Host every exported Durable Object class as a RivetKit actor and connect
 * this node to the control plane. Runs for the life of the node.
 */
export const runDurableObjects = (
  durableObjects: ReadonlyMap<string, DurableObjectExport>,
  runtime: BaseRuntimeContext & { readonly exports: unknown },
) =>
  Effect.gen(function* () {
    if (durableObjects.size === 0) return yield* Effect.never;
    const context = yield* Effect.context<never>();
    const { actor, setup } = yield* Effect.promise(() => import("rivetkit"));
    const { db } = yield* Effect.promise(() => import("rivetkit/db"));

    const use: Record<string, unknown> = {};
    for (const [name, exported] of durableObjects) {
      const build: WorkerBuild<DurableObjectExport, unknown> = {
        // The node program's context: every service the Worker's Effect built.
        context: context as Context.Context<any>,
        runtimeContext: runtime,
        export: exported,
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
    yield* Effect.logInfo(`Rivet node connected (${durableObjects.size} Durable Object classes)`);
    return yield* Effect.never.pipe(Effect.ensuring(Effect.promise(() => registry.shutdown())));
  });
