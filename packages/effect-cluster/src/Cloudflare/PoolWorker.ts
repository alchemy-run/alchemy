/**
 * The Worker a `ClusterCloudflare.DurableObjectPool` Layer deploys. While deploying it
 * declares the Durable Object classes every cluster uses; inside the
 * deployed Worker it also builds each class the pool hosts, registers
 * them for those objects, and serves the gateway callers reach them through.
 *
 * The pool Layer declares it, and the entry module it generates for the
 * Worker's bundle default-exports it with the hosted classes imported.
 *
 * @internal
 */
import * as Cloudflare from "@alchemy.run/cloudflare/Workers";
import type { InputProps } from "alchemy/Input";
import { makeEntrypointLayer } from "alchemy/Runtime";
import { stackFromEnv } from "alchemy/Runtime/Bootstrap";
import { Self } from "alchemy/Self";
import { Sharding } from "effect/cluster";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Scope from "effect/Scope";
import type { Workflow as EffectWorkflow } from "effect/workflow";
import type { HostedCron } from "../Cron.ts";
import { type HostedEntity, PlatformDeclaration } from "../Entity.ts";
import { authorized, gatewayServer } from "../internal/Gateway.ts";
import { HasNoPool, type HostedRuntimeContext } from "../internal/HostedRuntime.ts";
import type { HostedSingleton } from "../Singleton.ts";
import type { HostedWorkflow } from "../Workflow.ts";
import {
  EntityObject,
  makeObjectSharding,
  registry,
  ScheduledObject,
  scheduledObjectName,
  WorkflowObject,
  workflowEngine,
} from "./internal/Objects.ts";

type Hosted = HostedEntity | HostedWorkflow | HostedSingleton | HostedCron;

/** A class the Worker hosts: its name, and the module's default export. */
export interface HostedDefinition {
  readonly name: string;
  readonly value: unknown;
}

// oxlint-disable-next-line effecttsgo/service-not-as-class
const entrypointTag = Context.Service<any, any>(Self.key);

/** Build each class's Construction phase, keeping what its runtime context hosts. */
const buildHosted = (definitions: ReadonlyArray<HostedDefinition>, scope: Scope.Scope) =>
  Effect.forEach(definitions, ({ value }) =>
    Effect.gen(function* () {
      const declaration =
        (value as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ?? value;
      const context = yield* Layer.buildWithScope(
        makeEntrypointLayer(entrypointTag, declaration),
        scope,
      );
      const runtime = Context.get(context, entrypointTag)
        .RuntimeContext as HostedRuntimeContext<Hosted>;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new HasNoPool({
            message: `${runtime.Type} '${runtime.id}' did not finish its Construction phase.`,
          }),
        );
      }
      return built;
    }),
  );

/** Wake every singleton and cron, so their objects start their alarms. */
const wakeScheduled = (objects: {
  readonly getByName: (name: string) => { readonly ensure: () => Effect.Effect<void, unknown> };
}) =>
  Effect.forEach(
    registry.scheduled.values(),
    (hosted) =>
      objects.getByName(scheduledObjectName(hosted.kind, hosted.name)).ensure().pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );

/**
 * The pool's Worker `id`. `definitions` are the classes it hosts, which
 * only the deployed Worker builds; `props` are its props, which only the
 * deploy reads.
 */
export const poolWorker = (
  id: string,
  props: InputProps<Cloudflare.WorkerProps> | undefined,
  definitions: ReadonlyArray<HostedDefinition>,
) =>
  Cloudflare.Worker(
    id,
    props ?? {},
    Effect.gen(function* () {
      const entities = yield* EntityObject;
      const scheduled = yield* ScheduledObject;
      const workflows = yield* WorkflowObject;
      // A Cron Trigger wakes every singleton and cron each minute, in case
      // their alarms stopped.
      yield* Cloudflare.cron("* * * * *", () => wakeScheduled(scheduled));
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        return { fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })) };
      }
      // A class that fails to build fails every call, with its cause in the
      // Worker's logs rather than in a response anyone can read.
      return yield* serve(definitions, entities, scheduled, workflows).pipe(
        Effect.tapCause((cause) => Effect.logError("Effect Cluster pool failed to start", cause)),
        Effect.catchCause(() =>
          Effect.succeed({
            fetch: Effect.succeed(
              HttpServerResponse.text(
                "Effect Cluster pool failed to start; see the Worker's logs.",
                {
                  status: 503,
                },
              ),
            ),
          }),
        ),
      );
    }).pipe(Effect.provide(Cloudflare.CronEventSourceLive)),
  );

const serve = Effect.fn(function* (
  definitions: ReadonlyArray<HostedDefinition>,
  entities: unknown,
  scheduled: Parameters<typeof wakeScheduled>[0],
  workflows: unknown,
) {
  // The classes' own environment, which the deploy packs into one secret.
  const packed = yield* Config.String("CLUSTER_ENV").pipe(Config.withDefault(""));
  if (packed) yield* Effect.sync(() => Object.assign(globalThis.process.env, JSON.parse(packed)));
  const objectSharding = makeObjectSharding(() => entities as never);
  registry.sharding = objectSharding;
  // The isolate's own scope: built once, never closed (workerd has no
  // teardown hook).
  const scope = Scope.makeUnsafe();
  const hosted = yield* buildHosted(definitions, scope).pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, stackFromEnv)),
  );
  const hostedEntities = hosted.filter((entry): entry is HostedEntity => entry.kind === "entity");
  const hostedWorkflows = hosted.filter(
    (entry): entry is HostedWorkflow => entry.kind === "workflow",
  );
  for (const entry of hostedEntities) registry.entities.set(entry.entity.type, entry);
  for (const entry of hosted) {
    if (entry.kind === "singleton" || entry.kind === "cron") {
      registry.scheduled.set(entry.name, entry);
    }
  }

  // Workflows run on the Durable Object engine; each handler runs with
  // the services its Construction phase had, and the cluster's Sharding.
  const sharding = Layer.succeed(Sharding.Sharding, objectSharding);
  const engine = workflowEngine(() => workflows as never);
  const workflowLayers = hostedWorkflows.map((entry) =>
    (entry.workflow as EffectWorkflow.Workflow<string, any, any, any>).toLayer(
      (payload, executionId) =>
        entry
          .execute(payload, executionId)
          .pipe(
            Effect.provideContext(Context.add(entry.context, Sharding.Sharding, objectSharding)),
          ) as Effect.Effect<any, any, never>,
    ),
  );
  const services = yield* Layer.buildWithScope(
    Layer.mergeAll(...(workflowLayers as [Layer.Layer<never>])).pipe(
      Layer.provideMerge(engine),
      Layer.provideMerge(sharding),
    ),
    scope,
  );

  const token = Redacted.value(yield* Config.Redacted("CLUSTER_GATEWAY_TOKEN"));
  const { group, handlers } = gatewayServer(
    hostedEntities.map((entry) => entry.entity),
    new Map(hostedWorkflows.map((entry) => [entry.workflow._tag, entry.workflow])),
  );
  let woken = false;
  return {
    fetch: authorized(token)(
      Effect.gen(function* () {
        // The first call this isolate serves starts the singletons and
        // crons, so they run without waiting for the Cron Trigger.
        if (!woken) {
          woken = true;
          yield* wakeScheduled(scheduled);
        }
        const app = yield* RpcServer.toHttpEffect(group).pipe(
          Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
          Effect.provideContext(services),
        );
        return yield* app;
      }),
    ),
  };
});
