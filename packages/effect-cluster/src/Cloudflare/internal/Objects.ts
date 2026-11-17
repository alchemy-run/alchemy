/**
 * The Durable Object classes a `ClusterCloudflare.DurableObjectPool` Worker
 * exports. Every entity type shares one class, `ClusterEntity`, whose objects
 * are named by `(type, id)`; every workflow shares `ClusterWorkflow`, one
 * object per execution; every singleton and cron shares `ClusterScheduled`,
 * one object per name. What each object runs is host-neutral (see
 * `internal/ObjectSharding.ts`); this module gives it workerd's storage.
 *
 * @internal
 */
import * as Cloudflare from "@alchemy.run/cloudflare/Workers";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine, type ObjectImpl } from "alchemy/Workers/DurableObjectEngine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { InstanceStorage } from "../../Host.ts";
import type { EntityStorage } from "../../internal/EntityRuntime.ts";
import {
  type EntityObjectStub,
  makeEntityObject,
  makeScheduledObject,
  type Namespace,
  NotHosted,
  type ObjectHost,
  registry,
  type ScheduledObjectStub,
  workflowClassOf,
  workflowObjectName,
} from "../../internal/ObjectSharding.ts";

/** Cloudflare, as a host of the cluster's objects. */
export const host: ObjectHost = {
  group: "cloudflare",
  // workerd marks a transient failure `retryable`, and an `overloaded`
  // object wants less traffic, not more.
  isRetryable: (error) =>
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "retryable") &&
    error.cause.retryable === true &&
    !(Predicate.hasProperty(error.cause, "overloaded") && error.cause.overloaded === true),
};

/** The most bytes workerd's SQLite stores in one value. */
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;

/** workerd's own storage: its SQL is synchronous. */
interface NativeStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...bindings: ReadonlyArray<unknown>
    ) => { readonly toArray: () => Array<unknown> };
  };
  readonly transactionSync: <A>(run: () => A) => A;
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (at: number) => Promise<void>;
}

const objectName = (state: Cloudflare.DurableObjectState["Service"]) => state.id.name ?? "";

/**
 * The object's storage, called directly: a statement is one synchronous
 * call, so the mailbox costs no event-loop turns.
 */
const storageOf = (state: Cloudflare.DurableObjectState["Service"]): EntityStorage => {
  const storage = state.raw.storage as unknown as NativeStorage;
  return {
    exec: <T>(query: string, ...bindings: ReadonlyArray<unknown>) =>
      Effect.sync(() => storage.sql.exec(query, ...bindings).toArray() as Array<T>),
    // Every statement is synchronous, so the transaction is too.
    transaction: (effect) =>
      Effect.sync(() => storage.transactionSync(() => Effect.runSync(effect))),
    getAlarm: Effect.promise(() => storage.getAlarm()),
    setAlarm: (at) => Effect.promise(() => storage.setAlarm(at)),
  };
};

/** Every entity instance: one object per `(type, id)`. */
export const EntityObject = Cloudflare.DurableObject<EntityObjectStub>()(
  "ClusterEntity",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const runtime = yield* Effect.context<RuntimeContext>();
      return yield* makeEntityObject({
        name: objectName(state),
        host,
        storage: storageOf(state),
        // The object's own key-value storage, for platforms built on
        // entities (a Domain model's) to keep each instance's data in.
        runtime: Context.add(
          runtime,
          InstanceStorage,
          state.storage as unknown as InstanceStorage["Service"],
        ) as Context.Context<RuntimeContext>,
        maxEncodedBytes: MAX_ENCODED_BYTES,
        waitUntil: (effect) => state.waitUntil(effect).pipe(Effect.provideContext(runtime)),
      });
    });
  }),
);

/** Every singleton and cron: one object per name. */
export const ScheduledObject = Cloudflare.DurableObject<ScheduledObjectStub>()(
  "ClusterScheduled",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const runtime = yield* Effect.context<RuntimeContext>();
      return yield* makeScheduledObject({
        name: objectName(state),
        storage: storageOf(state),
        runtime,
      });
    });
  }),
);

/**
 * Every workflow execution: one object per `(workflow, execution)`, running
 * Alchemy's Durable Object workflow engine. The engine declares a class per
 * workflow; here each of those is a view onto this one class, so the Worker
 * exports the same classes whatever workflows it hosts.
 */
export const WorkflowObject = Cloudflare.DurableObject<Record<string, never>>()(
  "ClusterWorkflow",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const className = workflowClassOf(objectName(state));
      const impl = registry.workflows.get(className) as
        | ObjectImpl<Cloudflare.DurableObjectState>
        | undefined;
      if (impl === undefined) {
        return yield* Effect.die(
          new NotHosted({ message: `This Worker hosts no Cluster.Workflow '${className}'.` }),
        );
      }
      const object = yield* impl.pipe(Effect.provideService(Cloudflare.DurableObjectState, state));
      return (yield* object.pipe(
        Effect.provideService(Cloudflare.DurableObjectState, state),
      )) as Record<string, never>;
    });
  }),
);

/** The workflow engine, its executions on {@link WorkflowObject}. */
export const workflowEngine = (objects: () => Namespace<unknown>) =>
  makeDurableObjectEngine<never, Cloudflare.DurableObjectState>({
    declare: (className, impl) =>
      Effect.sync(() => {
        registry.workflows.set(className, impl);
        return {
          getByName: (executionId: string) =>
            objects().getByName(workflowObjectName(className, executionId)) as never,
        };
      }),
    state: Cloudflare.DurableObjectState,
  });
