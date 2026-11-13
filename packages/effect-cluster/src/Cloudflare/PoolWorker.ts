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
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Scope from "effect/Scope";
import { authorized, gatewayServer } from "../internal/Gateway.ts";
import {
  type HostedDefinition,
  hostClasses,
  makeObjectSharding,
  type Namespace,
  type ScheduledObjectStub,
  wakeScheduled,
} from "../internal/ObjectSharding.ts";
import {
  EntityObject,
  host,
  ScheduledObject,
  WorkflowObject,
  workflowEngine,
} from "./internal/Objects.ts";

export type { HostedDefinition } from "../internal/ObjectSharding.ts";

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
  scheduled: Namespace<ScheduledObjectStub>,
  workflows: unknown,
) {
  // The classes' own environment, which the deploy packs into one secret.
  const packed = yield* Config.String("CLUSTER_ENV").pipe(Config.withDefault(""));
  if (packed) yield* Effect.sync(() => Object.assign(globalThis.process.env, JSON.parse(packed)));
  // Built in the isolate's own scope: once, and never closed (workerd has
  // no teardown hook). Workflows run on the Durable Object engine.
  const hosted = yield* hostClasses({
    definitions,
    scope: Scope.makeUnsafe(),
    sharding: makeObjectSharding(() => entities as never, host),
    engine: workflowEngine(() => workflows as never),
  });

  const token = Redacted.value(yield* Config.Redacted("CLUSTER_GATEWAY_TOKEN"));
  const { group, handlers } = gatewayServer(
    hosted.entities.map((entry) => entry.entity),
    new Map(hosted.workflows.map((entry) => [entry.workflow._tag, entry.workflow])),
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
          Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
          Effect.provideContext(hosted.services),
        );
        return yield* app;
      }),
    ),
  };
});
