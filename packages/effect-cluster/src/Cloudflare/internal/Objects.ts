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
import {
  makeDurableObjectEngine,
  type ObjectImpl,
  provideCallbacks,
} from "alchemy/Workers/DurableObjectEngine";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Predicate from "effect/Predicate";
import { InstanceSockets, InstanceStorage, SOCKET_HEADER } from "../../Host.ts";
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
import { type Call, OBJECT_CALL_HEADER } from "../../internal/Wire.ts";

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

/** The class every entity instance's object is of. */
export const ENTITY_OBJECT_CLASS = "ClusterEntity";

/**
 * Every entity instance: one object per `(type, id)`. Its `fetch` accepts a
 * WebSocket a caller opened with `EntityNamespace.connect`, and hands it to
 * the call the upgrade carries; the object holds it as a hibernatable
 * WebSocket, so it stays open while the object is evicted.
 */
export const EntityObject = Cloudflare.DurableObject<EntityObjectStub>()(
  ENTITY_OBJECT_CLASS,
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const runtime = yield* Effect.context<RuntimeContext>();
      /** Sockets accepted for a call whose handler hasn't taken them yet. */
      const accepted = new Map<string, Cloudflare.WebSocket>();
      const sockets: InstanceSockets["Service"] = {
        accept: (id) =>
          Effect.sync(() => {
            const socket = accepted.get(id);
            accepted.delete(id);
            return socket;
          }),
        all: state.getWebSockets().pipe(Effect.provideContext(runtime)),
      };
      const object = yield* makeEntityObject({
        name: objectName(state),
        host,
        storage: storageOf(state),
        // The object's own key-value storage and WebSockets, for platforms
        // built on entities (a Domain model's) to keep each instance's data
        // and live reads in.
        runtime: Context.add(
          Context.add(
            runtime,
            InstanceStorage,
            state.storage as unknown as InstanceStorage["Service"],
          ),
          InstanceSockets,
          sockets,
        ) as Context.Context<RuntimeContext>,
        maxEncodedBytes: MAX_ENCODED_BYTES,
        waitUntil: (effect) => state.waitUntil(effect).pipe(Effect.provideContext(runtime)),
      });
      return {
        ...object,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const header = request.headers[OBJECT_CALL_HEADER];
          if (header === undefined || request.headers.upgrade?.toLowerCase() !== "websocket") {
            return HttpServerResponse.empty({ status: 426, headers: { Upgrade: "websocket" } });
          }
          const call = JSON.parse(header) as Omit<Call, "requestId">;
          const [response, socket] = yield* Cloudflare.upgrade();
          const requestId = SecureRandom.uuidV4Unsafe();
          accepted.set(requestId, socket);
          const reply = yield* object.ask(
            JSON.stringify({
              ...call,
              requestId,
              headers: { ...call.headers, [SOCKET_HEADER]: requestId },
            } satisfies Call),
          );
          // The call's handler took the socket: it is the instance's now.
          if (!accepted.delete(requestId)) return response;
          yield* socket.close(1011, "The call did not accept the WebSocket");
          return HttpServerResponse.text(reply, { status: 500 });
        }).pipe(Effect.orDie),
        // A client's messages are ignored; a close ends the socket.
        webSocketMessage: () => Effect.void,
        webSocketClose: (socket: Cloudflare.WebSocket) => socket.close(1000, ""),
        webSocketError: (socket: Cloudflare.WebSocket) => socket.close(1011, ""),
      };
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
      const object = yield* provideCallbacks(impl, Cloudflare.DurableObjectCallbacks).pipe(
        Effect.provideService(Cloudflare.DurableObjectState, state),
      );
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
