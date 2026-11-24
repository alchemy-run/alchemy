import { Callbacks, makeCallback } from "alchemy/Callback";
/**
 * A domain model on Durable Objects, for any runtime that hosts them:
 * Cloudflare, Rivet, Effect Cluster. Every aggregate instance, view key,
 * policy, projection key and stream key is one object, and this module is
 * everything those objects do. A platform supplies a {@link Host}: how to
 * declare a class of objects and call one by name, and, per instance, an
 * {@link ObjectState} (storage, an exclusive section, background work), its
 * `RuntimeContext`, and a `Callbacks` implementation.
 *
 * @module
 */
import type { HttpEffect } from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import { AlreadyCancelled, AlreadyExecuted, NotScheduled } from "./Aggregate.ts";
import * as Backfill from "./Backfill.ts";
import { type Routed, targetId } from "./CatchUp.ts";
import { DecisionsUnsupported, DefinitionError } from "./DefinitionError.ts";
import { admitStreamWrite, advanceStreamMeta } from "./InMemory.ts";
import type { KeyStore } from "./KeyStore.ts";
import {
  type Accepted,
  type AggregateKit,
  awaitsRevision,
  type CompactResult,
  type DecisionKit,
  decisionReceiptOf,
  type DecisionResult,
  captureContext,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  entryChanges,
  type HostedModel,
  hostedModels,
  type ImportMeta,
  type ImportResult,
  inRange,
  mergeRevised,
  outOfOrder,
  type Json,
  type ListRange,
  type ModelHost,
  mustReauthorize,
  Platform,
  type PolicyKit,
  type ProjectionKit,
  type Push,
  REAUTHORIZE_CLOSE_CODE,
  doneDelivery as doneOf,
  refolded,
  reviseEntries,
  type Revised,
  revisedBy,
  keptRecalls,
  type Reached,
  recallOf,
  reviseInputs,
  revisionKey,
  type RewriteInput,
  type RewriteResult,
  type RewriteStatus,
  type SeedResult,
  type SendResult,
  sendResultOf,
  stampRevisions,
  type StoredEvent,
  storedDecisionReceipt,
  type StoredResult,
  storedResult,
  viewInputOf,
  type StoredViewInput,
  type StreamEntry,
  type StreamHandled,
  type StreamKit,
  type StreamMeta,
  type StreamRevision,
  type StreamWrite,
  Subscription,
  type ViewEntry,
  type ViewInput,
  type ViewKit,
  type ViewSnapshot,
  withoutRevision,
} from "./Platform.ts";
import * as TwoPhase from "./TwoPhase.ts";

// ---------------------------------------------------------------- the host

/** Options for {@link ObjectStorage.list}. Keys come back in order. */
export interface ListOptions {
  /** Only keys that start with this prefix. */
  readonly prefix?: string;
  /** Only keys at or after this key. */
  readonly start?: string;
  /** Only keys after this key. */
  readonly startAfter?: string;
  /** Only keys before this key. */
  readonly end?: string;
  /** At most this many entries. */
  readonly limit?: number;
  /** Keys in descending order: `limit` counts from the end. */
  readonly reverse?: boolean;
}

/**
 * An object's own key-value storage. Values are structured-cloneable (plain
 * JSON is enough for everything Domain stores). Writes inside `transaction`
 * commit together, or not at all.
 */
export interface ObjectStorage {
  get<T>(key: string): Effect.Effect<T | undefined>;
  put<T>(key: string, value: T): Effect.Effect<void>;
  put<T>(entries: Record<string, T>): Effect.Effect<void>;
  delete(key: string): Effect.Effect<boolean>;
  delete(keys: ReadonlyArray<string>): Effect.Effect<number>;
  list<T>(options?: ListOptions): Effect.Effect<Map<string, T>>;
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

/** A live read's WebSocket, held by the object that owns its key. */
export interface ObjectSocket {
  send(message: string): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  /** Keep a value with the socket, across hibernation where the host has it. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment<T>(): T | null;
}

/** The instance an object's methods run against. */
export interface ObjectStateShape {
  readonly storage: ObjectStorage;
  /**
   * Run `effect` with every other event on this instance held back, as
   * Cloudflare's `blockConcurrencyWhile` does. Objects call each other only
   * outside it.
   */
  exclusive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Run `effect` in the background, keeping the instance alive until it ends. */
  waitUntil(effect: Effect.Effect<void>): Effect.Effect<void>;
  /**
   * Live reads pushed over WebSockets the object holds. Without it, live
   * reads are streamed responses that poll the object.
   */
  readonly sockets?: {
    /** Accept the current request's upgrade. */
    readonly accept: () => Effect.Effect<
      readonly [HttpServerResponse.HttpServerResponse, ObjectSocket]
    >;
    /** Every socket the instance holds. */
    readonly all: () => Effect.Effect<ReadonlyArray<ObjectSocket>>;
  };
}

/** The running object's state, which a host provides to every instance. */
export class ObjectState extends Context.Service<ObjectState, ObjectStateShape>()(
  "alchemy/Domain/ObjectState",
) {}

/** One object: every method is a call that returns an Effect. */
export interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<any>) => Effect.Effect<unknown, unknown>;
}

/** Every object of one class, by name. */
export interface Namespace {
  readonly getByName: (name: string) => Stub;
}

/** What an instance runs with. */
export type InstanceServices = ObjectState | RuntimeContext | Callbacks | Scope.Scope;

/**
 * An object's implementation: built once per instance, it returns the
 * instance's methods. The host calls them by name with JSON arguments, and
 * hands their JSON results back. A `fetch` method, when there is one, serves
 * the instance's HTTP requests (a live read's WebSocket upgrade).
 */
export type ObjectImpl = Effect.Effect<Record<string, unknown>, never, InstanceServices>;

/**
 * What a runtime supplies to host models on its Durable Objects. Class names
 * given to it are a model's own (`AccountAggregate`, `DepositsView`); the
 * host decides where they live (`Bank.AccountAggregate`).
 */
export interface Host<R = never> {
  /**
   * Declare a class of the model's objects while the model's Layer is built,
   * and return its namespace.
   */
  readonly declare: (
    model: HostedModel,
    name: string,
    impl: ObjectImpl,
  ) => Effect.Effect<Namespace, never, R>;
  /**
   * A class of the model by name, which code that doesn't build the model
   * (another isolate of the same deploy) can still reach. Optional.
   */
  readonly lookup?: (model: HostedModel, name: string) => Namespace | undefined;
  /** Called once per model when it is hosted, before any class is declared. */
  readonly hosted?: (model: HostedModel) => Effect.Effect<void, never, R>;
  /**
   * Forward a live read's WebSocket upgrade (the current request) to the
   * object named `key`. Hosts whose objects hold sockets supply it.
   */
  readonly connect?: (namespace: Namespace, key: string, subscription: Subscription) => HttpEffect;
  /**
   * Run the deploy's backfill of `targets`, and wait for it. Called while
   * deploying (not at runtime) when the deploy adds or rebuilds consumers.
   * Without it, each run starts on the first call after the deploy.
   */
  readonly backfill?: (
    model: HostedModel,
    /** Every plan the model has for these targets. */
    plans: (targets: ReadonlyArray<string>) => Readonly<Record<string, Backfill.Plan>>,
  ) => Effect.Effect<(targets: ReadonlyArray<string>) => Effect.Effect<void, never, R>, never, R>;
  /**
   * Begin the runs of the model's new consumers without waiting for a call.
   * Called at runtime, once the model is built, with the effect that begins
   * each run (each begins once). It fails, and keeps them pending, when a run
   * can't be reached. A host whose runtime can reach the model's objects on
   * its own (a runner that has joined its cluster) runs it in the background.
   * Without it, each run begins on the first Domain call after the deploy.
   */
  readonly begin?: (runs: Effect.Effect<void, unknown>) => Effect.Effect<void, never, R>;
  /**
   * Hand `effect` to the current invocation's lifetime (a Worker's or Durable
   * Object's `waitUntil`), so it finishes after the call that started it
   * returns. Succeeds with `false` when the current call has no lifetime to
   * extend (a Workflow step): `effect` then runs before the call does.
   * Without it, `effect` runs on a detached fiber, as a long-running process
   * keeps it alive.
   */
  readonly background?: (effect: Effect.Effect<void>) => Effect.Effect<boolean>;
  /** Models whose names collide on the same key fail to host: one per Worker, pool or class. */
  readonly claimKey: Effect.Effect<object, never, R>;
}

const pad = (n: number) => n.toString().padStart(12, "0");

/** Put rows in batches: Cloudflare's storage takes at most 128 keys a put. */
const putRows = <T>(storage: ObjectStorage, rows: ReadonlyArray<readonly [string, T]>) =>
  Effect.forEach(
    Arr.chunksOf(rows, 128),
    (batch) => storage.put(Object.fromEntries(batch) as Record<string, T>),
    { discard: true },
  );

/** Every row under a prefix, in key order, read a page at a time. */
const allRows = <T>(storage: ObjectStorage, prefix: string) =>
  Effect.gen(function* () {
    const out: Array<readonly [string, T]> = [];
    let after: string | undefined;
    while (true) {
      const page = yield* storage.list<T>({
        prefix,
        limit: 512,
        ...(after === undefined ? {} : { startAfter: after }),
      });
      out.push(...page.entries());
      if (page.size < 512) return out;
      after = out[out.length - 1]![0];
    }
  });

/** The storage list that reads exactly the `entry:` rows in `range`. */
const entryRange = (range: ListRange | undefined): ListOptions => {
  const limit = range?.limit === undefined ? {} : { limit: Math.max(0, range.limit) };
  return range?.order === "desc"
    ? {
        prefix: "entry:",
        ...(range.after === undefined ? {} : { end: `entry:${pad(range.after)}` }),
        reverse: true,
        ...limit,
      }
    : { prefix: "entry:", start: `entry:${pad((range?.after ?? 0) + 1)}`, ...limit };
};

const DefectTag = "alchemy/Domain/Defect";

/**
 * Calls between objects may lose thrown errors (Workers RPC replaces them
 * with an opaque "internal error"). Return failures as data instead, and
 * rethrow them as defects on the calling side.
 */
const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/**
 * How long to keep retrying a call that failed in transit: an instance being
 * reset reports an opaque error, and for a while after a deploy some instances
 * still run the previous code (whose classes don't implement our methods).
 * Backs off from 100ms to 2s, about a minute in total, so a call survives a
 * deploy's rollout.
 */
export const TRANSIT_RETRY = {
  // Whichever delay is shorter: exponential at first, then every 2 seconds.
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Call an object. A call that fails in transit is retried: every Domain
 * object method is idempotent (sends dedupe by command id, deliveries by
 * checkpoint, schedules replace, reads are reads). A defect the object
 * reported, or a call that keeps failing, is a defect for the caller.
 */
export const unwrapDefects = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry(TRANSIT_RETRY),
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/**
 * Call an object once, for the backfill protocol: it retries for itself,
 * backing off when the host refuses the load. Retrying here too (as
 * `unwrapDefects` does) would hold each level of a run for a minute.
 */
const callOnce = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/**
 * The class of a view or projection generation. A rebuilt consumer is a new
 * class (`DepositsViewV1`): it exists only in the code that rebuilds it, so
 * none of its objects can start on older code during a rollout, and the
 * previous generation's are left as they were (a shadow rebuild).
 */
export const consumerClass = (kind: "view" | "projection", name: string, generation: number) =>
  `${name}${kind === "view" ? "View" : "Projection"}${generation > 0 ? `V${generation}` : ""}`;

/**
 * The class of a consumer generation's run: its root, relays and scanners. A
 * class of its own, new with the deploy like the keys' class, so none of them
 * can start on older code; and apart from the keys, so a burst of keys that
 * runs an isolate out of memory doesn't reset the run that drives them.
 */
export const runClass = (keys: string) => `${keys}Run`;

/** A consumer's generation from its target id: `view:Name#2` is 2. */
export const generationOfTarget = (target: string) => Number(/#(\d+)$/.exec(target)?.[1] ?? 0);

/** The run class of a consumer, by target id. */
export const runClassOfTarget = (target: string) => {
  const { kind, name } = Backfill.consumerOf(target);
  return runClass(consumerClass(kind, name, generationOfTarget(target)));
};

/**
 * Run `effect` with every other event on this instance held back. Objects
 * may run each event in its own I/O context (Cloudflare does), so cross-event
 * in-memory coordination (semaphores, refs, deferreds) is unsafe; the host's
 * exclusive section is not.
 */
const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    return yield* state.exclusive(effect);
  });

/** What `scheduled:<name>` holds once that command is cancelled; never a job token. */
const CANCELLED = "cancelled";

/** What `armed:<name>` holds: the latest arming's command id, and when it is due. */
interface Armed {
  readonly commandId: string;
  readonly at: number;
}

/** How long a queue drain may hold its lease before another drain may take over. */
const LEASE_MS = 60_000;

/**
 * Take a drain's lease: `undefined` once taken, or when the lease another
 * drain holds ends. That drain may have died with an earlier instance and
 * left work behind, so a drain that can't take the lease looks again then.
 * Run it exclusively.
 */
const acquireLease = (state: ObjectStateShape, lease: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const held = yield* state.storage.get<number>(lease);
    if (held !== undefined && held > now) return held;
    yield* state.storage.put(lease, now + LEASE_MS);
    return undefined;
  });

/**
 * A durable, ordered work queue in the instance's storage. Rows are written
 * in the same transaction as the state change that produced them, processed
 * right after the commit (`kick`), and again by a durable callback if the
 * instance dies first. One drain runs at a time (a storage lease), rows are
 * processed in order, and a row is deleted only after its work succeeds.
 *
 * A `detached` queue never drains inside the call that staged its rows: its
 * callback runs them at once, as an event of its own. A drain's calls nest
 * inside the call it runs in, so an aggregate → policy → aggregate chain that
 * drained each hop inline would nest one level deeper per hop until the host
 * refuses the call (Cloudflare limits how deep a chain of calls may go).
 */
const queue = <Row>(
  name: string,
  process: (row: Row) => Effect.Effect<void>,
  options: { readonly detached?: boolean } = {},
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const prefix = `${name}:`;
    const lease = `${name}-lease`;
    const acquire = exclusively(acquireLease(state, lease));
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Durable Object provides its state and RuntimeContext on every event
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      // Nothing staged: nothing to do, and no lease to take.
      if ((yield* state.storage.list({ prefix, limit: 1 })).size === 0) return;
      const held = yield* acquire;
      if (held !== undefined) {
        // Another drain holds the lease, or held it when its instance died
        // (its rows are still here). Look again once the lease expires:
        // nothing else may, if no more rows are staged.
        yield* callback.schedule("drain", { at: held, payload: {} }).pipe(Effect.orDie);
        return;
      }
      yield* Effect.gen(function* () {
        const rows = yield* state.storage.list<Row>({ prefix });
        for (const [key, row] of rows) {
          yield* process(row);
          yield* state.storage.delete(key);
        }
      }).pipe(Effect.ensuring(state.storage.delete(lease).pipe(Effect.ignore)));
      // Rows staged while this drain ran.
      const more = yield* state.storage.list({ prefix, limit: 1 });
      if (more.size > 0) yield* drain;
    }) as Effect.Effect<void>;
    const callback = yield* makeCallback(`domain:${name}`, () => drain);
    return {
      /** Stage rows; call inside the storage transaction that commits their cause. */
      stage: (rows: ReadonlyArray<Row>) =>
        Effect.gen(function* () {
          if (rows.length === 0) return;
          const last = ((yield* state.storage.get<number>(`${name}-seq`)) ?? 0) + rows.length;
          yield* putRows(
            state.storage,
            rows.map((row, index) => [`${prefix}${pad(last - rows.length + index + 1)}`, row]),
          );
          yield* state.storage.put(`${name}-seq`, last);
          // The backstop: delivered even if this instance dies before `kick` runs.
          // Its rows are progress, so a callback staging them doesn't hand it
          // its retry budget. A detached queue's only drain.
          yield* callback.schedule("drain", {
            after: options.detached ? 0 : "10 seconds",
            payload: {},
            progress: last,
          });
        }),
      /**
       * Process staged rows now, in the background, keeping the instance alive
       * until done. A detached queue leaves them to its callback.
       */
      kick: options.detached
        ? Effect.void
        : state.waitUntil(
            drain.pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`domain ${name} drain failed; its callback retries`, cause),
              ),
            ),
          ),
      /** Process staged rows now, and wait (unless another drain holds the lease). */
      flush: drain,
    };
  });

// ---------------------------------------------------------------- live reads

/** What a live read's WebSocket carries across hibernation. */
export const Attachment = Schema.Struct({ key: Schema.String, subscription: Subscription });
export type Attachment = typeof Attachment.Type;
const decodeAttachment = Schema.decodeUnknownOption(Schema.fromJsonString(Attachment));

/**
 * The header a host's `connect` sets on the upgrade it forwards to an object:
 * the {@link Attachment} as JSON. The host sets it, overwriting any a client
 * sent, so the object can trust it.
 */
export const SUBSCRIPTION_HEADER = "x-domain-subscription";

/** Send a push to its socket; close it when the read ended or could not be judged. */
const deliverPush = <R>(socket: ObjectSocket, key: string, push: Effect.Effect<Push, never, R>) =>
  push.pipe(
    Effect.flatMap((pushed) =>
      Effect.gen(function* () {
        // Each frame carries the cursor a reconnecting client resumes from.
        const cursor = pushed.subscription.cursor;
        for (const message of pushed.messages) {
          yield* socket.send(JSON.stringify({ ...(message as object), cursor }));
        }
        if (pushed.done) return yield* socket.close(1000, "");
        yield* Effect.sync(() =>
          socket.serializeAttachment({
            key,
            subscription: pushed.subscription,
          } satisfies Attachment),
        );
      }),
    ),
    Effect.catchCause(() => socket.close(1011, "Domain could not push to this read")),
  );

/**
 * Accept a live read's WebSocket (the current request, forwarded by the
 * host's `connect`), and send what it starts with. Runs exclusively, so no
 * commit's push interleaves with the first one.
 */
const accept = (
  initial: (
    key: string,
    subscription: Subscription,
  ) => Effect.Effect<Push, never, ObjectState | RuntimeContext>,
  expiry: Expiry,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const request = yield* HttpServerRequest;
    const header = request.headers[SUBSCRIPTION_HEADER];
    const sockets = state.sockets;
    if (sockets === undefined) {
      return HttpServerResponse.text("Live reads are not pushed by this host", { status: 501 });
    }
    if (header === undefined || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426, headers: { Upgrade: "websocket" } });
    }
    const attachment = decodeAttachment(header);
    if (Option.isNone(attachment)) {
      return HttpServerResponse.text("Invalid live read", { status: 400 });
    }
    const { key, subscription } = attachment.value;
    return yield* exclusively(
      Effect.gen(function* () {
        // Armed before the socket is accepted: a read is never left open past its verdict.
        if (subscription.refused === undefined && subscription.validUntil !== undefined) {
          yield* expiry.arm(subscription.validUntil);
        }
        const [response, socket] = yield* sockets.accept();
        if (subscription.refused !== undefined) {
          yield* socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: subscription.requestId,
              exit: subscription.refused,
            }),
          );
          yield* socket.close(1000, "");
          return response;
        }
        yield* deliverPush(socket, key, initial(key, subscription));
        return response;
      }),
    );
  });

/**
 * Push to every live read of this instance after a commit. Runs inside the
 * commit's exclusive section. A read due to be judged again is closed instead,
 * with its cursor where it was, so the client reconnects through the read's
 * middleware and resumes.
 */
const broadcast = (
  push: (attachment: Attachment) => Effect.Effect<Push, never, ObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    if (state.sockets === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    for (const socket of yield* state.sockets.all()) {
      const attachment = socket.deserializeAttachment<Attachment>();
      if (attachment === null) continue;
      if (mustReauthorize(attachment.subscription, now)) {
        yield* socket.close(REAUTHORIZE_CLOSE_CODE, "reauthorize");
        continue;
      }
      yield* deliverPush(socket, attachment.key, push(attachment));
    }
  });

/** Closes this instance's live reads once their middleware's verdicts run out. */
interface Expiry {
  /** Make sure the instance wakes by `at` to close the reads due then. */
  readonly arm: (at: number) => Effect.Effect<void, never, ObjectState | RuntimeContext>;
}

/**
 * The instance's {@link Expiry}: one durable callback, due at the soonest
 * `validUntil` among its sockets. It wakes a hibernated object even when its
 * key has no commits, closes each read whose verdict has run out with
 * {@link REAUTHORIZE_CLOSE_CODE}, and arms itself for the next. The client
 * reconnects from its cursor, through the read's middleware.
 */
const makeExpiry = Effect.gen(function* () {
  const state = yield* ObjectState;
  const JOB = "live-reads";
  // Set once the callback exists: its handler arms it again for the next verdict.
  let rearm: (at: number) => Effect.Effect<void, never, RuntimeContext> = () => Effect.void;
  const callback = yield* makeCallback("domain:verdicts", (_: unknown) =>
    exclusively(
      Effect.gen(function* () {
        if (state.sockets === undefined) return;
        const now = yield* Clock.currentTimeMillis;
        let next = Infinity;
        for (const socket of yield* state.sockets.all()) {
          const until = socket.deserializeAttachment<Attachment>()?.subscription.validUntil;
          if (until === undefined) continue;
          if (now >= until) yield* socket.close(REAUTHORIZE_CLOSE_CODE, "reauthorize");
          else next = Math.min(next, until);
        }
        if (Number.isFinite(next)) yield* rearm(next);
      }),
    ).pipe(Effect.orDie),
  );
  rearm = (at) => callback.schedule(JOB, { at, payload: {} }).pipe(Effect.orDie);
  const expiry: Expiry = {
    arm: (at) =>
      Effect.gen(function* () {
        const pending = yield* callback.getStatus(JOB);
        if (pending !== undefined && pending.scheduledAt <= at) return;
        yield* callback.schedule(JOB, { at, payload: {} });
      }).pipe(Effect.orDie),
  };
  return expiry;
});

/** Live reads only receive; a client message or close needs no work beyond ending the socket. */
const socketHandlers = {
  webSocketMessage: () => Effect.void,
  webSocketClose: (socket: ObjectSocket) => socket.close(1000, "").pipe(Effect.ignoreCause),
  webSocketError: (socket: ObjectSocket) => socket.close(1011, "").pipe(Effect.ignoreCause),
};

// ---------------------------------------------------------------- backfill

/** Delete every stored key under these prefixes, a batch at a time. */
const clearPrefixes = (prefixes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    for (const prefix of prefixes) {
      while (true) {
        const keys = [...(yield* state.storage.list({ prefix, limit: 128 })).keys()];
        if (keys.length === 0) break;
        yield* state.storage.delete(keys);
      }
    }
  });

/**
 * What the backfill protocol runs on in one Durable Object: its storage (an
 * exclusive section is one transaction, with every other event held back),
 * and its jobs as durable callbacks. Each step counts as progress, so a long
 * backfill never exhausts a callback's retry budget.
 */
/** How many due backfill jobs one tick runs, and for how long, before it hands over to the next. */
const TICK_RUNS = 64;
const TICK_MILLIS = 5_000;

type Random = SecureRandom.SecureRandom["Service"];

const backfillRuntime = (
  random: Random,
  run: (id: string) => Effect.Effect<void, never, ObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    // Only these two services: a whole captured context would also carry
    // construction's references, such as the call an input gate (Rivet's)
    // tells calls apart by. Storage a commit's transaction reaches through a
    // job would then wait on the gate that transaction holds.
    const context = Context.make(ObjectState, state).pipe(
      Context.add(RuntimeContext, yield* RuntimeContext),
    );
    const provide = <A, E>(
      effect: Effect.Effect<A, E, ObjectState | RuntimeContext>,
    ): Effect.Effect<A, E> => Effect.provide(effect, context);
    const storage: Backfill.Storage = {
      get: <A>(key: string) => provide(state.storage.get<A>(key)),
      put: (entries) =>
        provide(
          Object.keys(entries).length === 0
            ? Effect.void
            : state.storage.put(entries as Record<string, unknown>),
        ),
      delete: (keys) =>
        provide(keys.length === 0 ? Effect.void : Effect.asVoid(state.storage.delete([...keys]))),
      list: <A>(options: {
        readonly prefix: string;
        readonly startAfter?: string;
        readonly limit?: number;
      }) =>
        provide(
          state.storage
            .list<A>({
              prefix: options.prefix,
              ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            })
            .pipe(Effect.map((rows) => [...rows.entries()])),
        ),
      exclusive: (effect) =>
        state.storage.transaction(effect).pipe(exclusively, Effect.orDie, provide),
    };
    // Jobs are rows here (`bf:job:<id>` holds when it's due and a token), run by one
    // alarm callback, the tick. A tick runs every due job, and those its jobs schedule
    // at once, until none is left or its budget is spent: scheduling a job writes one
    // row, where a callback of its own writes about ten. The tick's callback is
    // removed only once it returns, so a crash in between runs the tick again; a
    // job's row is removed only if it wasn't scheduled again while it ran.
    const jobKey = (id: string) => `bf:job:${id}`;
    let ticking = false;
    let dirty = false;
    /** The job running now, and the token of its row: that row doesn't count as already scheduled. */
    let current: { readonly id: string; readonly token: string } | undefined;
    const now = Clock.currentTimeMillis;
    // One at a time: the callback is one row, so a later schedule would replace a sooner one.
    const tickLock = yield* Semaphore.make(1);
    /** Make sure a tick fires by `due`. */
    const tickBy = (due: number) =>
      Effect.gen(function* () {
        const pending = yield* state.storage.get<number>("bf:tick");
        if (pending !== undefined && pending <= due) return;
        const at = yield* now;
        // A callback ignores a schedule whose progress isn't past the last one's: count
        // them, rather than use the clock (each event has its own, and they disagree).
        const progress = ((yield* state.storage.get<number>("bf:tick-progress")) ?? 0) + 1;
        yield* callback.schedule("tick", {
          after: `${Math.max(0, due - at)} millis`,
          payload: {},
          progress,
        });
        yield* state.storage.put({ "bf:tick": due, "bf:tick-progress": progress });
      }).pipe(Effect.orDie, tickLock.withPermits(1));
    const tick: Effect.Effect<void, never, ObjectState | RuntimeContext> = Effect.gen(function* () {
      yield* state.storage.delete("bf:tick");
      ticking = true;
      const started = yield* now;
      let runs = 0;
      while (true) {
        dirty = false;
        const at = yield* now;
        const rows = [
          ...(yield* state.storage.list<{ due: number; token: string }>({
            prefix: "bf:job:",
          })).entries(),
        ];
        const due = rows.filter(([, job]) => job.due <= at);
        const spent = runs >= TICK_RUNS || at - started >= TICK_MILLIS;
        if ((due.length === 0 && !dirty) || spent) {
          ticking = false;
          const next = Math.min(...rows.map(([, job]) => job.due));
          if (Number.isFinite(next)) yield* tickBy(spent ? Math.min(next, at) : next);
          return;
        }
        for (const [key, job] of due) {
          runs += 1;
          current = { id: key.slice("bf:job:".length), token: job.token };
          yield* run(current.id);
          current = undefined;
          const after = yield* state.storage.get<{ due: number; token: string }>(key);
          if (after?.token === job.token) yield* state.storage.delete(key);
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          ticking = false;
          current = undefined;
        }),
      ),
    );
    const callback = yield* makeCallback("domain:backfill", (_: unknown) => tick);
    const jobs: Backfill.Jobs = {
      schedule: (id, afterMillis) =>
        provide(
          Effect.gen(function* () {
            const due = (yield* now) + afterMillis;
            const stored = yield* state.storage.get<{ due: number; token: string }>(jobKey(id));
            // The running job's own row is done once it returns; one scheduled while it
            // ran (by a message that arrived meanwhile) still stands.
            const existing =
              stored !== undefined && current?.id === id && stored.token === current.token
                ? undefined
                : stored;
            // The earliest request wins: already due sooner, that run sees this cause too.
            if (existing !== undefined && existing.due <= due) return;
            const token = yield* random.uuidV4();
            yield* state.storage.put(jobKey(id), {
              due: existing !== undefined ? Math.min(existing.due, due) : due,
              token,
            });
            // A running tick picks it up.
            if (ticking) {
              dirty = true;
              return;
            }
            yield* tickBy(due);
          }).pipe(Effect.orDie),
        ),
    };
    return { storage, jobs, provide };
  });

/** What a backfill needs to know of a consumer, in the deployed model. */
export type PlanOf = (target: string) => Backfill.Plan | undefined;

/** Every plan the model has for these targets, as an announcement carries them. */
export const plansOf = (targets: ReadonlyArray<string>, planOf: PlanOf) => {
  const plans: Record<string, Backfill.Plan> = {};
  for (const target of targets) {
    const plan = planOf(target);
    if (plan !== undefined) plans[target] = plan;
  }
  return plans;
};

/** A directory node: one object per path in the tree. */
const directoryObject = (net: Backfill.Network, random: Random): ObjectImpl =>
  Effect.gen(function* () {
    let node: Backfill.Node | undefined;
    const runtime = yield* backfillRuntime(random, (id) => node!.run(id));
    node = Backfill.makeNode(runtime.storage, runtime.jobs, net, Backfill.defaultLimits);
    const role = node;
    return {
      register: (path: string, ref: Backfill.SourceRef) => reportDefects(role.register(path, ref)),
      child: (path: string, child: string) => reportDefects(role.child(path, child)),
      list: (path: string, after: string | undefined) => reportDefects(role.list(path, after)),
    };
  });

/**
 * The object of a consumer's class that scans one source instance for it: one
 * per instance and consumer generation, new with the deploy.
 */
const scannerName = (ref: Backfill.SourceRef) =>
  `~scan/${ref.source}/${ref.id}${ref.generation ? `#${ref.generation}` : ""}`;

/** A consumer object's scanner methods (an object named by `scannerName`). */
const scannerRpc = (scanner: () => Backfill.Scanner) => ({
  bfScannerScan: (target: string, ref: Backfill.SourceRef, waitMillis: number) =>
    reportDefects(scanner().scan(target, ref, waitMillis)),
  bfScannerReady: (target: string, waitMillis: number) =>
    reportDefects(scanner().ready(target, waitMillis)),
  bfScannerKick: (target: string, ref: Backfill.SourceRef) =>
    reportDefects(scanner().kick(target, ref)),
});

/**
 * How long the root of a relay run works in one alarm before it starts another
 * (an alarm may run for 15 minutes): keys still reading history are called again.
 */
const RELAY_ROOT_WAIT_MS = 5 * 60_000;

/** The object of a consumer's class at the root of its run: it drives the run's passes. */
export const RUN_ROOT = "~run";

/** The object of a consumer's class for one relay of its run. */
const relayName = (target: string, name: string) => `~relay/${target}/${name}`;

/**
 * A consumer object's run methods. Every part of a consumer's run (its root,
 * relays and scanners) is an object of the consumer's own class: a class the
 * deploy adds exists only in the deployed code, so none of them can start on
 * older code during a rollout. The root (`RUN_ROOT`) drives the run's passes
 * from its alarm (see `Backfill.makeRun`), so whoever starts it (the deploy's
 * Workflow, or the first call after a local redeploy) only asks how far it
 * has got.
 */
const runRpc = (relay: Backfill.Relay, run: () => Backfill.Run) => ({
  bfRelayRun: (
    name: string,
    relayRun: Backfill.RelayRun,
    items: ReadonlyArray<Backfill.RelayItem>,
  ) => reportDefects(relay.run(name, relayRun, items)),
  bfRunBegin: (target: string, plan: Backfill.Plan) => reportDefects(run().begin(target, plan)),
  bfRunPhase: (target: string) => reportDefects(run().phase(target)),
  bfRunProgress: (target: string) => reportDefects(run().progress(target)),
});

/** How long before a key that couldn't list itself in the directory tries again. */
const REGISTER_RETRY_MS = 2_000;

/** The id an instance was listed under, saved so jobs that fire later find it. */
const ID_KEY = "bf:id";

/** The job that lists an instance in the directory, after its first commit. */
const REGISTER_JOB = "bf-register";

/**
 * List an instance in the directory, so every instance with an event can be
 * reached when a consumer is added later.
 */
const ensureRegistered = (net: Backfill.Network, ref: Backfill.SourceRef) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    if (yield* state.storage.get<boolean>("registered")) return;
    yield* net.node.register(Backfill.leafOf(ref), ref);
    yield* state.storage.put({ registered: true, [ID_KEY]: ref.id });
  });

/**
 * Note, in the storage write of an instance's commit, that it still has to be
 * listed in the directory. The first commit doesn't wait for the directory
 * (which may have to link new nodes up to its root): the {@link REGISTER_JOB}
 * lists the instance after the call returns, and is retried until it does.
 * Every instance that has committed can still be found, as the job is stored
 * with the commit and survives an eviction or a restart.
 *
 * Call it inside the commit's transaction.
 */
const listAfterCommit = (jobs: Backfill.Jobs, id: string) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    if (yield* state.storage.get<boolean>("registered")) return;
    yield* state.storage.put({ [ID_KEY]: id });
    yield* jobs.schedule(REGISTER_JOB, 0);
  });

/**
 * The register job: list the instance in the directory, then ask for a reader
 * for each consumer it is behind (one deployed between its commit and now, that
 * the run which listed the directory didn't find it for). A failure tries again.
 */
const registerJob = (
  net: Backfill.Network,
  ref: Backfill.SourceRef,
  source: Backfill.Source,
  jobs: Backfill.Jobs,
) =>
  ensureRegistered(net, ref).pipe(
    Effect.andThen(source.catchUp),
    Effect.catchCause(() => jobs.schedule(REGISTER_JOB, REGISTER_RETRY_MS)),
  );

/**
 * What an instance holds for a decision until it commits or aborts: the whole
 * plan on the primary, its own part on any other. See `TwoPhase`.
 */
type Intent = (TwoPhase.Plan | TwoPhase.Prepare) & {
  /**
   * When it was stored, on this instance's clock. Only to tell a commit
   * under way from one whose driver stopped; never to decide an outcome.
   */
  readonly at: number;
};

/** The primary holds the plan; any other instance holds its own part. */
const isPlan = (intent: Intent): intent is TwoPhase.Plan & { readonly at: number } =>
  "others" in intent;

/** How many stored events one step of a rewrite or a compaction takes. */
const REWRITE_PAGE = 128;

/** Where an object keeps the revision a source sent for one of its events. */
const revisionRow = (source: string, seq: number) => `rev:${source}|${pad(seq)}`;

/**
 * A rewrite under way on an instance, which holds it (`meta.held`). It first
 * reads the whole log to learn what the rewrite leaves (`check`), so nothing
 * changes when that breaks an invariant; then it changes the log a page at a
 * time (`apply`). Each step is one exclusive section, and the job is stored,
 * so a rewrite goes on after the call driving it dies.
 */
interface RewriteJob extends RewriteInput {
  readonly id: string;
  readonly phase: "check" | "apply";
  /** The last `seq` this phase has read. */
  readonly through: number;
  /** The state folded from the rewritten events read so far. */
  readonly state: Json;
  /** How many events it changes. */
  readonly changed: number;
  /** The keys it has sent revisions to, with where each is delivered. */
  readonly sent: ReadonlyArray<{ readonly target: Delivery["target"]; readonly key: string }>;
}

/** What an instance keeps of a rewrite it has run. */
interface RewriteRecord {
  readonly result: RewriteResult;
  readonly status: RewriteStatus;
}

/** A compaction whose replaced events are still to be handed over and removed. */
interface Compacting {
  readonly id: string;
  readonly name: string;
  readonly through: number;
}

/** What the primary keeps of an attempt's outcome, until each of `waiting` has it. */
interface Recorded {
  readonly outcome: TwoPhase.Outcome;
  readonly waiting: ReadonlyArray<TwoPhase.Address>;
}

/**
 * How long a decision's driver is left alone before something else carries
 * the decision on: the instance's wake-up, or a command that finds it held.
 * A commit takes a few calls; one still held after this was most likely
 * dropped by its driver. Helping early is harmless, only wasteful.
 */
const RESUME_AFTER_MS = 2_000;

/** A decision's intent holds the instance: nothing else commits to it until that settles. */
class InstanceHeld extends Data.TaggedError("InstanceHeld")<{}> {
  override get message() {
    return "the instance stayed held by a decision whose primary instance couldn't be reached";
  }
}

/** How long a command waits for an instance a decision holds: about 13 seconds. */
const HELD = {
  schedule: Schedule.min([Schedule.exponential("10 millis"), Schedule.spaced("250 millis")]),
  times: 60,
} as const;

/** The object of another instance, for the two-phase commit: `undefined` when its class isn't in this code. */
type Peer = (address: TwoPhase.Address) => Stub | undefined;

/** Give a step the state and runtime of the call it runs in. */
type Provided = <A, E>(
  effect: Effect.Effect<A, E, ObjectState | RuntimeContext>,
) => Effect.Effect<A, E>;

/** A decision this code hosts, by its command's tag. */
type DecisionOf = (name: string) => DecisionKit | undefined;

/** A few tries, about a second: the primary holds its instance while it calls. */
const PEER_RETRY = { schedule: Schedule.exponential("50 millis"), times: 4 } as const;

const sameAddress = (a: TwoPhase.Address, b: TwoPhase.Address) =>
  a.aggregate === b.aggregate && a.id === b.id;

const aggregateObject = (
  kit: AggregateKit,
  net: Backfill.Network,
  model: () => ReadonlyArray<string>,
  planOf: PlanOf,
  random: Random,
  peer: Peer,
  decisionOf: DecisionOf,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const outbox = yield* queue<Delivery>("outbox", kit.deliver);
    // `held` marks an instance a decision's intent holds, so a command learns
    // it from the row it reads anyway.
    const storedMeta = state.storage
      .get<{ state: Json; version: number; held?: true }>("meta")
      .pipe(Effect.map((meta) => meta ?? { state: null, version: 0 }));
    const currentMeta = Effect.map(storedMeta, ({ state, version }) => ({ state, version }));
    const eventsAfter = (after: number) =>
      state.storage
        .list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}` })
        .pipe(Effect.map((rows) => [...rows.values()]));
    /** The stored events at these `seq`s: those that are still there. */
    const eventsAt = (seqs: ReadonlyArray<number>) =>
      Effect.map(
        Effect.forEach(seqs, (seq) => state.storage.get<StoredEvent>(`event:${pad(seq)}`)),
        (rows) => rows.filter((row): row is StoredEvent => row !== undefined),
      );

    // This instance as a backfill source: consumers added later pull its events.
    let source: Backfill.Source | undefined;
    const runtime = yield* backfillRuntime(
      random,
      (id): Effect.Effect<void, never, ObjectState | RuntimeContext> =>
        id === "bf-flush" || id === REGISTER_JOB
          ? Effect.flatMap(state.storage.get<string>(ID_KEY), (stored) =>
              stored === undefined
                ? Effect.void
                : id === REGISTER_JOB
                  ? registerJob(
                      net,
                      { source: kit.name, id: stored },
                      sourceFor(stored),
                      runtime.jobs,
                    )
                  : sourceFor(stored).flush,
            )
          : Effect.void,
    );
    const sourceFor = (id: string): Backfill.Source =>
      (source ??= Backfill.makeSource(runtime.storage, runtime.jobs, net, {
        ref: { source: kit.name, id },
        singleSource: (target) => planOf(target)?.singleSource === true,
        model,
        targets: () => kit.targets,
        log: (after, limit) =>
          runtime.provide(
            state.storage
              .list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}`, limit })
              .pipe(Effect.map((rows) => [...rows.values()])),
          ),
        version: runtime.provide(Effect.map(currentMeta, (meta) => meta.version)),
        routed: runtime.provide(state.storage.get<Routed>("routed")),
        markLive: (target) =>
          runtime.provide(
            Effect.gen(function* () {
              const { version } = yield* currentMeta;
              const routed = yield* state.storage.get<Routed>("routed");
              yield* state.storage.put("routed", { ...routed, [target]: version });
            }),
          ),
      }));

    // Callers run it `exclusively`.
    const commit = (id: string, command: Json, meta: Aggregate.SendMeta) =>
      Effect.gen(function* () {
        const duplicate = yield* state.storage.get<StoredResult>(`receipt:${meta.commandId}`);
        // A resend may follow an instance that died before delivering what the
        // first commit staged: deliver it now rather than at the backstop.
        if (duplicate)
          return { sent: yield* resent(id, duplicate), kick: duplicate._tag === "Accepted" };
        const current = yield* storedMeta;
        if (current.held) return yield* new InstanceHeld();
        const result = yield* kit.handle({
          id,
          state: current.state,
          version: current.version,
          command,
          commandId: meta.commandId,
          context: meta.context,
          now: yield* Clock.currentTimeMillis,
          correlationId: meta.correlationId,
          trace: meta.trace,
          link: meta.link,
        });
        if (result._tag === "Rejected") return { sent: result as SendResult, kick: false };
        const sent: SendResult = {
          _tag: "Accepted",
          receipt: {
            stream: `${kit.name}/${id}`,
            version: result.version,
            events: result.events.map((e) => e.event),
            reply: result.reply,
          },
        };
        const kick = yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* state.storage.put<StoredResult>(
              `receipt:${meta.commandId}`,
              storedResult(result.version, result.events.length, result.reply),
            );
            return yield* persist(id, current.version, result);
          }),
        );
        return { sent, kick };
      });
    /** A stored result as `send` answers it: its events are read back from the log. */
    const resent = (id: string, result: StoredResult) =>
      Effect.gen(function* () {
        const stream = `${kit.name}/${id}`;
        if (result._tag === "Rejected" || "receipt" in result)
          return sendResultOf(stream, result, []);
        const { version, count } = result.stored;
        const rows =
          count === 0
            ? new Map<string, StoredEvent>()
            : yield* state.storage.list<StoredEvent>({
                prefix: "event:",
                start: `event:${pad(version - count + 1)}`,
                end: `event:${pad(version + 1)}`,
              });
        return sendResultOf(stream, result, [...rows.values()]);
      });
    // Callers run it through `whenFree`: an import never lands under a decision's intent.
    const importEvents = (id: string, events: ReadonlyArray<Json>, meta: ImportMeta) =>
      Effect.gen(function* () {
        const duplicate = yield* state.storage.get<StoredResult>(`receipt:${meta.commandId}`);
        if (duplicate?._tag === "Accepted") {
          const again = yield* resent(id, duplicate);
          if (again._tag === "Accepted") {
            const imported: ImportResult = { _tag: "Imported", receipt: again.receipt };
            // As a resent command: deliver what the first import may have left staged.
            return { imported, kick: true };
          }
        }
        const current = yield* storedMeta;
        if (current.held) return yield* new InstanceHeld();
        if (current.version !== meta.expectedVersion) {
          const imported: ImportResult = { _tag: "UnexpectedVersion", version: current.version };
          return { imported, kick: false };
        }
        const now = yield* Clock.currentTimeMillis;
        const latest =
          current.version === 0
            ? 0
            : ((yield* state.storage.get<StoredEvent>(`event:${pad(current.version)}`))?.envelope
                .at ?? 0);
        const refused = outOfOrder(meta.at, events.length, latest, now);
        if (refused) return { imported: refused as ImportResult, kick: false };
        const result = yield* kit.seed({
          id,
          state: current.state,
          version: current.version,
          events,
          commandId: meta.commandId,
          now,
          ...(meta.at === undefined ? {} : { at: meta.at }),
        });
        const receipt = {
          stream: `${kit.name}/${id}`,
          version: result.version,
          events: result.events.map((e) => e.event),
          reply: null,
        };
        const kick = yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* state.storage.put<StoredResult>(
              `receipt:${meta.commandId}`,
              storedResult(receipt.version, receipt.events.length, null),
            );
            return yield* persist(id, current.version, result);
          }),
        );
        const imported: ImportResult = { _tag: "Imported", receipt };
        return { imported, kick };
      });
    /**
     * Store decided events, the state after them and their deliveries. Call
     * inside the storage transaction that commits them; `true` when there are
     * deliveries to send.
     */
    const persist = (id: string, from: number, result: SeedResult) =>
      Effect.gen(function* () {
        yield* putRows(
          state.storage,
          result.events.map((event) => [`event:${pad(event.envelope.seq)}`, event]),
        );
        yield* state.storage.put("meta", { state: result.state, version: result.version });
        // Listed in the directory after the call returns, not before it commits.
        yield* listAfterCommit(runtime.jobs, id);
        // Live to caught-up consumers; through the backfill to lagging ones.
        const live = yield* Backfill.routeCommit(
          sourceFor(id),
          kit.targets,
          yield* state.storage.get<Routed>("routed"),
          from,
          result.version,
          result.deliveries,
        );
        yield* state.storage.put("routed", live.routed);
        yield* outbox.stage(live.send);
        return live.send.length > 0;
      });

    // ------------------------------------------------ rewrites
    // `rw-job`: the rewrite under way, with `meta.held` set. `rw:<rewriteId>`:
    // what became of each rewrite. `rev-n`: the revisions sent so far.
    const rewriteJob = state.storage.get<RewriteJob>("rw-job");
    const rewriteRecord = (rewriteId: string) =>
      state.storage.get<RewriteRecord>(`rw:${rewriteId}`);
    /**
     * One step of the rewrite under way: a page of the log, in one exclusive
     * section. `false` once no rewrite is under way.
     */
    const rewriteStep = exclusively(
      state.storage.transaction(
        Effect.gen(function* () {
          const job = yield* rewriteJob;
          if (job === undefined) return { more: false, kick: false };
          const rows = [
            ...(yield* state.storage.list<StoredEvent>({
              prefix: "event:",
              start: `event:${pad(job.through + 1)}`,
              limit: REWRITE_PAGE,
            })).values(),
          ];
          const deletes = kit.deletes(job.name);
          /** End the rewrite: the instance takes commands again. */
          const finish = (result: RewriteResult, sent: ReadonlyArray<Revised>, meta?: Json) =>
            Effect.gen(function* () {
              const current = yield* currentMeta;
              yield* state.storage.put("meta", {
                state: meta === undefined ? current.state : meta,
                version: current.version,
              });
              yield* state.storage.put<RewriteRecord>(`rw:${job.rewriteId}`, {
                result,
                status: { done: true, sent },
              });
              yield* state.storage.delete("rw-job");
              yield* rewriteWaker.cancel("rewrite").pipe(Effect.ignore);
            });
          const root = `${kit.name}/${job.id}#${job.rewriteId}`;
          if (rows.length === 0 && job.phase === "check") {
            // The copies view keys kept of the events a compaction removed.
            const reached = (yield* state.storage.get<ReadonlyArray<Reached>>("reached")) ?? [];
            const recalled = kit.recall(
              job.id,
              root,
              {
                name: job.name,
                input: job.input,
                through: (yield* state.storage.get<number>("removed")) ?? 0,
              },
              reached,
            );
            if (job.changed === 0 && recalled.length === 0) {
              yield* finish({ _tag: "Rewritten", changed: 0 }, []);
              return { more: false, kick: false };
            }
            const invariant = deletes ? undefined : kit.broken(job.state);
            if (invariant !== undefined) {
              yield* finish({ _tag: "InvariantBroken", invariant }, []);
              return { more: false, kick: false };
            }
            const last = (yield* state.storage.get<number>("rev-n")) ?? 0;
            const revisions = recalled.map((delivery, index) => ({
              ...delivery,
              revision: { ...delivery.revision!, n: last + index + 1 },
            }));
            yield* state.storage.put("rev-n", last + revisions.length);
            yield* outbox.stage(revisions);
            yield* state.storage.put<RewriteJob>("rw-job", {
              ...job,
              phase: "apply",
              through: 0,
              state: null,
              changed: 0,
              sent: revisions.map(({ target, key }) => ({ target, key })),
            });
            return { more: true, kick: revisions.length > 0 };
          }
          if (rows.length === 0) {
            // Every event is as the rewrite leaves it: tell each key it reached, and let go.
            const last = (yield* state.storage.get<number>("rev-n")) ?? 0;
            const at = yield* Clock.currentTimeMillis;
            const done = job.sent.map(({ target, key }, index) =>
              doneOf({ origin: kit.name, id: job.id }, root, last + index + 1, target, key, at),
            );
            yield* state.storage.put("rev-n", last + done.length);
            yield* outbox.stage(done);
            if (deletes) {
              // What it kept of the commands it handled and scheduled goes with it.
              for (const name of (yield* state.storage.list({ prefix: "armed:" })).keys()) {
                yield* timers.cancel(name.slice("armed:".length)).pipe(Effect.ignore);
              }
              yield* clearPrefixes(["receipt:", "decided:", "armed:", "scheduled:"]);
              yield* state.storage.delete("reached");
            } else {
              // A decision's receipt stored with a copy of its events keeps none of them.
              for (const [key, stored] of yield* state.storage.list<TwoPhase.Plan["receipt"]>({
                prefix: "decided:",
              })) {
                if (stored.at !== undefined || stored.events.length === 0) continue;
                yield* state.storage.put(key, { ...stored, events: [] });
              }
              // A receipt stored with a copy of its events keeps their count instead.
              for (const [key, stored] of yield* state.storage.list<StoredResult>({
                prefix: "receipt:",
              })) {
                if (stored._tag !== "Accepted" || !("receipt" in stored)) continue;
                yield* state.storage.put<StoredResult>(
                  key,
                  storedResult(
                    stored.receipt.version,
                    stored.receipt.events.length,
                    stored.receipt.reply,
                  ),
                );
              }
            }
            yield* finish(
              { _tag: "Rewritten", changed: job.changed },
              revisedBy(done),
              deletes ? null : job.state,
            );
            return { more: false, kick: done.length > 0 };
          }
          const { state: folded, changes } = yield* kit.rewrite({
            id: job.id,
            name: job.name,
            input: job.input,
            state: job.state,
            events: rows,
          });
          const through = rows[rows.length - 1]!.envelope.seq;
          if (job.phase === "check") {
            yield* state.storage.put<RewriteJob>("rw-job", {
              ...job,
              through,
              state: folded,
              changed: job.changed + changes.length,
            });
            return { more: true, kick: false };
          }
          const gone = changes.filter((change) => change.after === undefined);
          if (gone.length > 0) {
            yield* state.storage.delete(gone.map((change) => `event:${pad(change.seq)}`));
          }
          yield* putRows(
            state.storage,
            changes.flatMap((change) =>
              change.after === undefined
                ? []
                : [[`event:${pad(change.seq)}`, change.after] as const],
            ),
          );
          const last = (yield* state.storage.get<number>("rev-n")) ?? 0;
          const revisions = (yield* kit.revise(job.id, root, changes)).map((delivery, index) => ({
            ...delivery,
            revision: { ...delivery.revision!, n: last + index + 1 },
          }));
          yield* state.storage.put("rev-n", last + revisions.length);
          yield* outbox.stage(revisions);
          const sent = new Map(
            job.sent.map((to) => [`${targetId(to.target)}|${to.key}`, to] as const),
          );
          for (const { target, key } of revisions) {
            sent.set(`${targetId(target)}|${key}`, { target, key });
          }
          yield* state.storage.put<RewriteJob>("rw-job", {
            ...job,
            through,
            state: folded,
            changed: job.changed + changes.length,
            sent: [...sent.values()],
          });
          return { more: true, kick: revisions.length > 0 };
        }),
      ),
    ).pipe(Effect.orDie);
    /** Carry the rewrite under way to its end. Calls no other object, but runs outside `exclusively`. */
    const driveRewrite: Effect.Effect<void, never, ObjectState | RuntimeContext> = Effect.gen(
      function* () {
        while (true) {
          const { more, kick } = yield* rewriteStep;
          if (kick) yield* outbox.kick;
          if (!more) return;
        }
      },
    );
    // Should the call driving a rewrite die, this carries it on.
    const rewriteWaker = yield* makeCallback("domain:rewrite", (_: unknown) =>
      driveRewrite.pipe(Effect.orDie),
    );
    const rewrite = (id: string, input: RewriteInput) =>
      Effect.gen(function* () {
        const started = yield* whenFree(
          id,
          Effect.gen(function* () {
            const seen = yield* rewriteRecord(input.rewriteId);
            if (seen !== undefined) return seen.result;
            const current = yield* storedMeta;
            if (current.held) return yield* new InstanceHeld();
            yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* state.storage.put<RewriteJob>("rw-job", {
                  ...input,
                  id,
                  phase: "check",
                  through: 0,
                  state: null,
                  changed: 0,
                  sent: [],
                });
                yield* state.storage.put("meta", { ...(yield* currentMeta), held: true });
              }),
            );
            yield* rewriteWaker
              .schedule("rewrite", { after: "10 seconds", payload: {} })
              .pipe(Effect.orDie);
            return undefined;
          }),
        );
        if (started !== undefined) return started;
        yield* driveRewrite;
        const record = yield* rewriteRecord(input.rewriteId);
        return record === undefined
          ? yield* Effect.die(new Error(`the rewrite ${input.rewriteId} left no result`))
          : record.result;
      });
    const rewriteStatus = (rewriteId: string) =>
      Effect.gen(function* (): Generator<any, RewriteStatus | undefined> {
        const record = yield* rewriteRecord(rewriteId);
        if (record !== undefined) return record.status;
        const job = yield* rewriteJob;
        return job?.rewriteId === rewriteId ? { done: false, sent: [] } : undefined;
      });

    // ------------------------------------------------ compactions
    // `compacted`: the version at the last roll-up. `compacting`: the events
    // a roll-up replaced that are still to be handed over and removed.
    // `removed`: the last `seq` a compaction removed. `reached`: the view keys
    // the removed events had reached, which a later rewrite tells.
    /**
     * Hand the events a roll-up replaced to the compaction's handler, a page
     * at a time, and remove each page once the handler has it. The handler
     * runs outside `exclusively`: commands keep committing meanwhile.
     */
    const handOver: Effect.Effect<number, never, ObjectState | RuntimeContext> = Effect.gen(
      function* () {
        let removed = 0;
        while (true) {
          const compacting = yield* state.storage.get<Compacting>("compacting");
          if (compacting === undefined) return removed;
          const rows = yield* state.storage.list<StoredEvent>({
            prefix: "event:",
            end: `event:${pad(compacting.through + 1)}`,
            limit: REWRITE_PAGE,
          });
          if (rows.size === 0) {
            yield* state.storage.delete("compacting");
            yield* compactionWaker.cancel("compact").pipe(Effect.ignore);
            return removed;
          }
          const compaction = kit.compactions.find((c) => c.name === compacting.name);
          if (compaction !== undefined)
            yield* compaction.archive(compacting.id, [...rows.values()]);
          // A rewrite after this finds the copies view keys kept of them.
          const reached = yield* kit.reached(compacting.id, [...rows.values()]);
          if (reached.length > 0) {
            const had = (yield* state.storage.get<ReadonlyArray<Reached>>("reached")) ?? [];
            const known = new Set(had.map(({ name, key }) => `${name}|${key}`));
            const news = reached.filter(({ name, key }) => !known.has(`${name}|${key}`));
            if (news.length > 0) yield* state.storage.put("reached", [...had, ...news]);
          }
          yield* state.storage.delete([...rows.keys()]);
          removed += rows.size;
        }
      },
    );
    // Should the call handing events over die, or its handler fail, this tries again.
    const compactionWaker = yield* makeCallback("domain:compact", (_: unknown) =>
      handOver.pipe(Effect.asVoid, Effect.orDie),
    );
    const compact = (id: string, name: string) =>
      Effect.gen(function* () {
        // What an earlier compaction left to hand over goes first.
        const left = yield* handOver;
        const done = (version: number, compacted: number): CompactResult => ({
          _tag: "Compacted",
          version,
          compacted,
        });
        const outcome = yield* whenFree(
          id,
          Effect.gen(function* () {
            const current = yield* storedMeta;
            if (current.held) return yield* new InstanceHeld();
            const before = current.version;
            if (before === 0 || (yield* state.storage.get<number>("compacted")) === before) {
              return { result: done(before, left), kick: false };
            }
            const rolled = yield* kit.rollup({
              id,
              name,
              state: current.state,
              version: before,
              now: yield* Clock.currentTimeMillis,
            });
            const lossy: CompactResult = { _tag: "Lossy" };
            if (rolled === undefined) return { result: lossy, kick: false };
            // Events a consumer still catching up has yet to read stay until the next one.
            const routed = yield* state.storage.get<Routed>("routed");
            const through = Math.min(
              before,
              // No cursors: it predates catch-up, and every consumer is taken as caught up.
              ...kit.targets.map((target) =>
                routed === undefined ? before : (routed[target] ?? 0),
              ),
            );
            const kick = yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* state.storage.put("compacted", rolled.version);
                yield* state.storage.put<Compacting>("compacting", { id, name, through });
                const removed = (yield* state.storage.get<number>("removed")) ?? 0;
                yield* state.storage.put("removed", Math.max(removed, through));
                return yield* persist(id, before, rolled);
              }),
            );
            yield* compactionWaker
              .schedule("compact", { after: "10 seconds", payload: {} })
              .pipe(Effect.orDie);
            return { result: done(rolled.version, left), kick };
          }),
        );
        if (outcome.kick) yield* outbox.kick;
        if (outcome.result._tag === "Lossy") return outcome.result;
        return done(outcome.result.version, outcome.result.compacted + (yield* handOver));
      });
    /** Compact, in the background, an instance that holds more events than a compaction's Layer allows. */
    const compactWhenDue = (id: string, version: number) =>
      Effect.gen(function* () {
        const limits = kit.compactions.filter((c) => c.afterEvents !== undefined);
        if (limits.length === 0) return;
        const since = version - ((yield* state.storage.get<number>("compacted")) ?? 0);
        const due = limits.find((c) => since > c.afterEvents!);
        if (due === undefined) return;
        const services = yield* Effect.context<ObjectState | RuntimeContext>();
        yield* state.waitUntil(
          compact(id, due.name).pipe(
            Effect.flatMap((result) =>
              result._tag === "Lossy"
                ? Effect.logWarning(`${due.name} would lose state on ${kit.name}/${id}`)
                : Effect.void,
            ),
            // A handler that fails leaves the events: its wake-up tries again.
            Effect.catchCause((cause) => Effect.logError(`compaction ${due.name} failed`, cause)),
            Effect.provide(services),
          ),
        );
      });

    // ------------------------------------------------ decisions (see `TwoPhase`)
    // `intent`: what this instance holds for an attempt, with `meta.held` set.
    // `decided:<commandId>`: the receipt of a decision committed here, as its primary.
    // `tx:<txId>`: as the primary, an attempt's outcome and who hasn't received it.
    const intentOf = state.storage.get<Intent>("intent");
    const outcomeKey = (txId: string) => `tx:${txId}`;
    const decidedOf = (commandId: string) =>
      state.storage.get<TwoPhase.Plan["receipt"]>(`decided:${commandId}`);
    /** Let go of the intent: the instance takes commands again. Call inside a transaction. */
    const release = Effect.gen(function* () {
      yield* state.storage.delete("intent");
      yield* state.storage.put("meta", yield* currentMeta);
    });
    /** Cancel the wake-up, once nothing here is waiting on it. Set below. */
    let rest: Effect.Effect<void, never, RuntimeContext> = Effect.void;
    /**
     * Turn the intent into events. On the primary this is the commit point:
     * the same transaction keeps the receipt, and the outcome for the others.
     * Callers run it `exclusively`.
     */
    const applyIntent = (id: string, txId: string) =>
      Effect.gen(function* () {
        const intent = yield* intentOf;
        if (intent === undefined || intent.txId !== txId) return { applied: false, kick: false };
        const current = yield* currentMeta;
        const result =
          intent.events.length === 0
            ? undefined
            : yield* kit.record({
                id,
                state: current.state,
                version: current.version,
                events: intent.events,
                commandId: intent.commandId,
                now: intent.now,
                correlationId: intent.correlationId,
                trace: intent.trace,
              });
        const kick = yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* release;
            if (isPlan(intent)) {
              yield* state.storage.put(
                `decided:${intent.commandId}`,
                storedDecisionReceipt(intent.receipt),
              );
              if (intent.others.length > 0) {
                yield* state.storage.put<Recorded>(outcomeKey(txId), {
                  outcome: "Committed",
                  waiting: intent.others.map(({ aggregate, id }) => ({ aggregate, id })),
                });
              }
            }
            return result === undefined ? false : yield* persist(id, current.version, result);
          }),
        );
        yield* Effect.suspend(() => rest);
        return { applied: true, kick };
      }).pipe(Effect.orDie);
    /** Drop the intent, as an instance told its attempt aborted. Callers run it `exclusively`. */
    const dropIntent = (txId: string) =>
      Effect.gen(function* () {
        const intent = yield* intentOf;
        if (intent?.txId !== txId) return;
        yield* state.storage.transaction(release);
        yield* Effect.suspend(() => rest);
      });
    /** Another instance, as the primary calls it. A call that fails is `Unreachable`. */
    const participant = (address: TwoPhase.Address): TwoPhase.Participant => {
      const stub = peer(address);
      const call = <A>(method: string, ...args: ReadonlyArray<unknown>) =>
        stub === undefined
          ? Effect.fail(new TwoPhase.Unreachable({ cause: `${address.aggregate} isn't hosted` }))
          : callOnce<A>(stub[method]!(address.id, ...args)).pipe(
              Effect.catchCause((cause) => Effect.fail(new TwoPhase.Unreachable({ cause }))),
            );
      return {
        read: call<TwoPhase.ReadResult>("txRead").pipe(Effect.retry(PEER_RETRY)),
        prepare: (prepare) =>
          call<TwoPhase.PrepareResult>("txPrepare", prepare).pipe(Effect.retry(PEER_RETRY)),
        commit: (txId) => call<void>("txCommit", txId),
        abort: (txId) => call<void>("txAbort", txId),
      };
    };
    /** This instance's storage, as the primary of a decision: each step is one exclusive section. */
    const primaryOf = (id: string, provided: Provided): TwoPhase.Primary => ({
      read: (commandId) =>
        Effect.gen(function* () {
          if (!(yield* settle(id))) return { _tag: "Busy" } as const;
          return yield* exclusively(
            Effect.gen(function* () {
              const receipt = yield* decidedOf(commandId);
              if (receipt !== undefined) return { _tag: "Decided", receipt } as const;
              if ((yield* intentOf) !== undefined) return { _tag: "Busy" } as const;
              if ((yield* rewriteJob) !== undefined) return { _tag: "Busy" } as const;
              return { _tag: "Read", ...(yield* currentMeta) } as const;
            }),
          );
        }).pipe(provided),
      hold: (plan) =>
        exclusively(
          Effect.gen(function* () {
            const receipt = yield* decidedOf(plan.commandId);
            if (receipt !== undefined) return { _tag: "Decided", receipt } as const;
            if ((yield* intentOf) !== undefined) return { _tag: "Busy" } as const;
            if ((yield* rewriteJob) !== undefined) return { _tag: "Busy" } as const;
            if ((yield* currentMeta).version !== plan.version) return { _tag: "Conflict" } as const;
            yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* state.storage.put<Intent>("intent", {
                  ...plan,
                  at: yield* Clock.currentTimeMillis,
                });
                yield* state.storage.put("meta", { ...(yield* currentMeta), held: true });
              }),
            );
            // Should this call die, the wake-up finishes the plan from storage.
            yield* wake(id);
            return { _tag: "Held" } as const;
          }),
        ).pipe(provided),
      commit: (txId) =>
        Effect.gen(function* () {
          const { applied, kick } = yield* exclusively(applyIntent(id, txId));
          if (kick) yield* outbox.kick;
          if (applied) return "Committed" as const;
          const recorded = yield* state.storage.get<Recorded>(outcomeKey(txId));
          return recorded?.outcome === "Committed" ? ("Committed" as const) : ("Gone" as const);
        }).pipe(provided),
      abort: (txId) =>
        exclusively(
          Effect.gen(function* () {
            const intent = yield* intentOf;
            if (intent?.txId !== txId || !isPlan(intent)) {
              // Not held: it ended already. An attempt nobody remembers aborted,
              // or every instance has its outcome, so whoever asks holds a stray copy.
              return (yield* state.storage.get<Recorded>(outcomeKey(txId)))?.outcome ?? "Aborted";
            }
            yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* release;
                if (intent.others.length > 0) {
                  yield* state.storage.put<Recorded>(outcomeKey(txId), {
                    outcome: "Aborted",
                    waiting: intent.others.map(({ aggregate, id }) => ({ aggregate, id })),
                  });
                }
              }),
            );
            yield* Effect.suspend(() => rest);
            return "Aborted" as const;
          }),
        ).pipe(provided),
      delivered: (txId, others) =>
        exclusively(
          Effect.gen(function* () {
            const recorded = yield* state.storage.get<Recorded>(outcomeKey(txId));
            if (recorded === undefined) return;
            const waiting = recorded.waiting.filter(
              (address) => !others.some((other) => sameAddress(address, other)),
            );
            if (waiting.length > 0) {
              return yield* state.storage.put<Recorded>(outcomeKey(txId), { ...recorded, waiting });
            }
            yield* state.storage.delete(outcomeKey(txId));
            yield* Effect.suspend(() => rest);
          }),
        ).pipe(provided),
    });
    /**
     * What drives a decision from this instance. Its steps run in the call
     * that asks for it, so they take that call's state and runtime: an object
     * may run each call in a context of its own.
     */
    const driveOf = (id: string) =>
      Effect.map(Effect.context<ObjectState | RuntimeContext>(), (services): TwoPhase.Drive => ({
        primary: primaryOf(id, (effect) => Effect.provide(effect, services)),
        participant,
        receipt: (stored) =>
          decisionReceiptOf(stored, (stream, seqs) => {
            const [aggregate = "", ...rest] = stream.split("/");
            const address = { aggregate, id: rest.join("/") };
            if (address.aggregate === kit.name && address.id === id) {
              return Effect.provide(eventsAt(seqs), services);
            }
            const stub = peer(address);
            // An instance that can't be reached gives none: the receipt is still its commits and reply.
            return stub === undefined
              ? Effect.succeed([])
              : callOnce<ReadonlyArray<StoredEvent>>(stub.eventsAt(seqs)).pipe(
                  Effect.catchCause(() => Effect.succeed([])),
                );
          }),
      }));
    /** As the primary: what became of an attempt, for an instance that holds its intent and asks. */
    const outcomeOf = (txId: string) =>
      Effect.gen(function* () {
        if ((yield* intentOf)?.txId === txId) return "Pending" as const;
        return (yield* state.storage.get<Recorded>(outcomeKey(txId)))?.outcome ?? "Aborted";
      });
    /**
     * Settle the intent this instance holds, if it can be. The primary
     * carries its plan on, once its driver has had its time. Any other
     * instance asks the primary. `true` when the instance is free. Calls
     * other objects, so it runs outside `exclusively`.
     */
    const settle = (id: string): Effect.Effect<boolean, never, ObjectState | RuntimeContext> =>
      Effect.gen(function* () {
        // A rewrite holds the instance too: carry it on, and the instance is free.
        if ((yield* rewriteJob) !== undefined) {
          yield* driveRewrite;
          return true;
        }
        const intent = yield* intentOf;
        if (intent === undefined) return true;
        if (isPlan(intent)) {
          if ((yield* Clock.currentTimeMillis) - intent.at < RESUME_AFTER_MS) return false;
          yield* TwoPhase.finish(yield* driveOf(id), intent);
          return true;
        }
        const primary = peer(intent.primary);
        if (primary === undefined) return false;
        const outcome = yield* callOnce<TwoPhase.Outcome | "Pending">(
          primary.txOutcome(intent.primary.id, intent.txId),
        ).pipe(Effect.catchCause(() => Effect.succeed("Pending" as const)));
        if (outcome === "Pending") return false;
        if (outcome === "Aborted") {
          yield* exclusively(dropIntent(intent.txId));
          return true;
        }
        const { kick } = yield* exclusively(applyIntent(id, intent.txId));
        if (kick) yield* outbox.kick;
        return true;
      });
    /**
     * Run `effect` exclusively once no decision holds the instance: one whose
     * driver stopped is settled first.
     */
    const whenFree = <A, E extends { readonly _tag: string }>(
      id: string,
      effect: Effect.Effect<A, E | InstanceHeld, ObjectState | RuntimeContext>,
    ) => {
      const attempt = exclusively(effect);
      return attempt.pipe(
        // Settle what holds it, then try again at once: most intents settle here.
        Effect.catchTag("InstanceHeld", () => Effect.andThen(settle(id), attempt)),
        Effect.retry({ ...HELD, while: (error) => error._tag === "InstanceHeld" }),
        Effect.catchTag("InstanceHeld", (held) => Effect.die(held)),
      );
    };
    // The wake-up: while this instance holds an intent, or an outcome some
    // instance hasn't received, it wakes to carry that on. It is what makes
    // a decision finish when the call that was driving it died.
    const waker = yield* makeCallback("domain:settle", (job: { readonly id: string }) =>
      Effect.gen(function* () {
        const free = yield* settle(job.id);
        const drive = yield* driveOf(job.id);
        const pending = yield* state.storage.list<Recorded>({ prefix: "tx:" });
        yield* Effect.forEach(
          pending,
          ([key, recorded]) =>
            TwoPhase.deliver(drive, key.slice("tx:".length), recorded.outcome, recorded.waiting),
          { discard: true },
        );
        const left = yield* state.storage.list({ prefix: "tx:", limit: 1 });
        // Dying asks for another wake-up: the host redelivers it a little later each time.
        if (!free || left.size > 0) return yield* Effect.die(new InstanceHeld());
      }).pipe(Effect.orDie),
    );
    const wake = (id: string) =>
      waker
        .schedule("settle", { after: Duration.millis(RESUME_AFTER_MS), payload: { id } })
        .pipe(Effect.orDie);
    rest = Effect.gen(function* () {
      if ((yield* intentOf) !== undefined) return;
      if ((yield* state.storage.list({ prefix: "tx:", limit: 1 })).size > 0) return;
      yield* waker.cancel("settle").pipe(Effect.ignore);
    });
    const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
      Effect.gen(function* () {
        const { sent, kick } = yield* whenFree(id, commit(id, command, meta));
        if (kick) yield* outbox.kick;
        if (sent._tag === "Accepted") yield* compactWhenDue(id, sent.receipt.version);
        return sent;
      });
    const executed = (commandId: string) =>
      state.storage
        .get<StoredResult>(`receipt:${commandId}`)
        .pipe(Effect.map((receipt) => receipt !== undefined));
    // Scheduled commands: one durable callback job per name, run here when
    // due. `scheduled:<name>` holds the token of the job that may run, or
    // `CANCELLED` once it is cancelled, so a job cancelled or replaced after
    // the alarm claimed it does nothing. It is cleared after the commit (the
    // receipt takes over), so a retried job still runs. `armed:<name>` keeps
    // the latest arming's command id and due time: the same arming again
    // changes nothing, and its receipt tells whether the name's command ran.
    const timers = yield* makeCallback(
      "domain:schedule",
      (job: {
        readonly id: string;
        readonly command: Json;
        readonly meta: Aggregate.SendMeta;
        readonly token?: string;
        /** Absent on jobs scheduled before names: the command id stands in. */
        readonly name?: string;
      }) =>
        Effect.gen(function* () {
          const key = `scheduled:${job.name ?? job.meta.commandId}`;
          const kick = yield* whenFree(
            job.id,
            Effect.gen(function* () {
              // A job scheduled before tokens existed has none, and runs.
              if (job.token !== undefined && (yield* state.storage.get<string>(key)) !== job.token)
                return false;
              const { kick } = yield* commit(job.id, job.command, job.meta);
              yield* state.storage.delete(key);
              return kick;
            }),
          );
          if (kick) yield* outbox.kick;
          // A failure is a defect here: the job is redelivered.
        }).pipe(Effect.orDie),
    );
    return {
      send: (id: string, command: Json, meta: Aggregate.SendMeta) =>
        reportDefects(send(id, command, meta)),
      schedule: (
        id: string,
        name: string,
        command: Json,
        meta: Aggregate.SendMeta,
        due: Aggregate.Due,
      ) =>
        Effect.gen(function* () {
          // The same arming again (a policy or step ran again): leave it as it is.
          const armed = yield* state.storage.get<Armed>(`armed:${name}`);
          if (armed?.commandId === meta.commandId) return { at: armed.at };
          // Before arming records (2.0.0-beta.85 and earlier) a name was its
          // arming's command id, so a receipt under a name with no arming
          // record is that arming's command, already run: this is the same
          // arming again (a policy redelivered after an upgrade). Record it
          // as this arming, so it stays a no-op and a later trigger arms the
          // name again.
          if (armed === undefined && (yield* executed(name))) {
            const at = yield* Clock.currentTimeMillis;
            yield* state.storage.put(`armed:${name}`, { commandId: meta.commandId, at });
            return { at };
          }
          const token = yield* random.uuidV4();
          const at = "at" in due ? due.at : (yield* Clock.currentTimeMillis) + due.afterMillis;
          yield* state.storage.put(`armed:${name}`, { commandId: meta.commandId, at });
          yield* state.storage.put(`scheduled:${name}`, token);
          yield* timers.schedule(name, {
            at,
            payload: { id, command, meta, token, name },
          });
          return { at };
        }).pipe(exclusively, reportDefects),
      unschedule: (name: string) =>
        Effect.gen(function* () {
          // Before names, the command id was the name.
          const armed = yield* state.storage.get<Armed>(`armed:${name}`);
          if (yield* executed(armed?.commandId ?? name)) return "AlreadyExecuted" as const;
          const key = `scheduled:${name}`;
          const token = yield* state.storage.get<string>(key);
          if (token === CANCELLED) return "AlreadyCancelled" as const;
          // A job scheduled before tokens existed has a job but no token.
          if (token === undefined && (yield* timers.getStatus(name)) === undefined)
            return "NotScheduled" as const;
          yield* state.storage.put(key, CANCELLED);
          yield* timers.cancel(name);
          return "Cancelled" as const;
        }).pipe(exclusively, reportDefects),
      importEvents: (id: string, events: ReadonlyArray<Json>, meta: ImportMeta) =>
        Effect.gen(function* () {
          const { imported, kick } = yield* whenFree(id, importEvents(id, events, meta));
          if (kick) yield* outbox.kick;
          return imported;
        }).pipe(reportDefects),
      state: () => reportDefects(currentMeta),
      after: (after: number) => reportDefects(eventsAfter(after)),
      eventsAt: (seqs: ReadonlyArray<number>) => reportDefects(eventsAt(seqs)),
      rewrite: (id: string, input: RewriteInput) => reportDefects(rewrite(id, input)),
      rewriteStatus: (rewriteId: string) => reportDefects(rewriteStatus(rewriteId)),
      compact: (id: string, name: string) => reportDefects(compact(id, name)),
      // A decision, with this instance as its primary: see `TwoPhase.decide`.
      txDecide: (id: string, name: string, command: Json, meta: Aggregate.SendMeta) =>
        Effect.gen(function* () {
          const decision = decisionOf(name);
          if (decision === undefined) {
            return yield* Effect.die(
              new Error(`the decision ${name} isn't in the code ${id} runs`),
            );
          }
          return yield* TwoPhase.decide({
            kit: decision,
            command,
            meta,
            drive: yield* driveOf(id),
            txId: Effect.orDie(random.uuidV4()),
          });
        }).pipe(reportDefects),
      // As the primary: what became of an attempt, for an instance that holds its intent.
      txOutcome: (_id: string, txId: string) => outcomeOf(txId).pipe(exclusively, reportDefects),
      // As any other instance of a decision: see `TwoPhase.Participant`.
      txRead: (id: string) =>
        Effect.gen(function* () {
          if (!(yield* settle(id))) return { _tag: "Busy" } satisfies TwoPhase.ReadResult;
          return yield* exclusively(
            Effect.gen(function* (): Generator<any, TwoPhase.ReadResult> {
              if ((yield* intentOf) !== undefined) return { _tag: "Busy" };
              if ((yield* rewriteJob) !== undefined) return { _tag: "Busy" };
              return { _tag: "Read", ...(yield* currentMeta) };
            }),
          );
        }).pipe(reportDefects),
      txPrepare: (id: string, prepare: TwoPhase.Prepare) =>
        Effect.gen(function* () {
          yield* settle(id);
          return yield* exclusively(
            Effect.gen(function* (): Generator<any, TwoPhase.PrepareResult> {
              const held = yield* intentOf;
              if (held !== undefined) {
                return held.txId === prepare.txId ? { _tag: "Prepared" } : { _tag: "Busy" };
              }
              if ((yield* rewriteJob) !== undefined) return { _tag: "Busy" };
              if ((yield* currentMeta).version !== prepare.version) return { _tag: "Conflict" };
              yield* state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put<Intent>("intent", {
                    ...prepare,
                    at: yield* Clock.currentTimeMillis,
                  });
                  yield* state.storage.put("meta", { ...(yield* currentMeta), held: true });
                }),
              );
              // Should the outcome never arrive, it wakes and asks the primary.
              yield* wake(id);
              return { _tag: "Prepared" };
            }),
          );
        }).pipe(reportDefects),
      // The primary recorded the outcome before it told anyone, so it is taken at its word.
      txCommit: (id: string, txId: string) =>
        Effect.gen(function* () {
          const { kick } = yield* exclusively(applyIntent(id, txId));
          if (kick) yield* outbox.kick;
        }).pipe(reportDefects),
      txAbort: (_id: string, txId: string) => dropIntent(txId).pipe(exclusively, reportDefects),
      // The backfill protocol, as a source.
      // Any code answers these: a run reads its log, and routes it with its own code.
      bfLog: (id: string, after: number, limit: number) =>
        reportDefects(sourceFor(id).log(after, limit)),
      bfCursor: (id: string, target: string) => reportDefects(sourceFor(id).cursor(target)),
      bfRead: (id: string, target: string, key: string, after: number, limit: number) =>
        reportDefects(sourceFor(id).read(target, key, after, limit)),
      bfHandoff: (id: string, target: string, key: string, through: number) =>
        reportDefects(sourceFor(id).handoff(target, key, through)),
    };
  });

const viewObject = (
  kit: ViewKit,
  net: Backfill.Network,
  model: () => ReadonlyArray<string>,
  planOf: PlanOf,
  random: Random,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const expiry = yield* makeExpiry;
    const outbox = yield* queue<Delivery>("outbox", kit.deliver);
    const stored = state.storage
      .get<ViewSnapshot>("snapshot")
      .pipe(Effect.map((s) => s ?? emptySnapshot));
    // Built by an earlier generation of the view: it reads as empty, and starts over on write.
    const stale = (snapshot: ViewSnapshot) => (snapshot.generation ?? 0) < kit.generation;
    const read = stored.pipe(Effect.map((s) => (stale(s) ? emptySnapshot : s)));
    const reset = Effect.gen(function* () {
      if (!stale(yield* stored)) return;
      yield* clearPrefixes(["entry:", "in:", "rev:", "rev-wait:", "revised:"]);
      yield* state.storage.delete(["snapshot", "routed", "in-seq", "revs"]);
    });
    // `revs`: the revisions this key holds (`rev:<source>|<seq>` rows) until
    // their source says it has sent them all, the last it took from each
    // source, and how many it has sent its own consumers.
    const revs = state.storage
      .get<ViewRevisions>("revs")
      .pipe(Effect.map((found) => found ?? { pending: 0, taken: {}, n: 0 }));
    /** Whether the key still holds a revision of `root` from `source`, for an event yet to arrive. */
    const awaits = (root: string, source: string) =>
      Effect.map(state.storage.list<Delivery>({ prefix: `rev:${source}|` }), (rows) =>
        awaitsRevision(rows.values(), root, source),
      );
    const entriesAfter = (after: number) =>
      stored.pipe(
        Effect.flatMap((snapshot) =>
          stale(snapshot)
            ? Effect.succeed([])
            : state.storage
                .list<ViewEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
                .pipe(Effect.map((rows) => [...rows.values()])),
        ),
      );
    const entriesIn = (range: ListRange | undefined) =>
      stored.pipe(
        Effect.flatMap((snapshot) =>
          stale(snapshot)
            ? Effect.succeed([])
            : state.storage
                .list<ViewEntry>(entryRange(range))
                .pipe(Effect.map((rows) => [...rows.values()])),
        ),
      );
    const target = kit.target;
    // Pushes and sends an apply leaves for after its transaction commits.
    let after: Array<Effect.Effect<void, never, ObjectState | RuntimeContext>> = [];

    /**
     * Apply deliveries to the key and route what it emits. Callers hold the
     * exclusive section and its transaction.
     */
    const apply = (key: string, arrived: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        yield* reset;
        const before = yield* read;
        // An event a rewrite changed before it got here arrives as it is now.
        const held = yield* revs;
        let deliveries = arrived;
        if (held.pending > 0) {
          const taken: Array<Delivery> = [];
          const used: Array<Delivery> = [];
          for (const delivery of arrived) {
            const row = revisionRow(delivery.source, delivery.seq);
            const revised = yield* state.storage.get<Delivery>(row);
            if (revised === undefined) {
              taken.push(delivery);
              continue;
            }
            yield* state.storage.delete(row);
            used.push(revised);
            if (!revised.revision?.gone) taken.push(withoutRevision(revised));
          }
          if (used.length > 0) {
            yield* state.storage.put("revs", { ...held, pending: held.pending - used.length });
          }
          // The last event a rewrite was waiting for: the key has now taken all of it.
          for (const revised of used) {
            const root = revised.revision!.root;
            const waiting = `rev-wait:${root}|${revised.source}`;
            const sent = yield* state.storage.get<ReadonlyArray<Revised>>(waiting);
            if (sent === undefined) continue;
            if (yield* awaits(root, revised.source)) continue;
            const row = `revised:${root}|${revised.source}`;
            const had = (yield* state.storage.get<ReadonlyArray<Revised>>(row)) ?? [];
            yield* state.storage.put(row, mergeRevised(had, sent));
            yield* state.storage.delete(waiting);
          }
          deliveries = taken;
        }
        // An event its source removed, rewritten since: it arrives as the rewrite leaves it.
        const recalls = held.recalls ?? [];
        for (const recall of recalls) {
          const { rows } = yield* kit.recall(key, recall, deliveries);
          deliveries = rows.map((row) => viewInputOf(row).delivery);
        }
        const result = yield* kit.apply(key, before, deliveries);
        if (recalls.length > 0) {
          const kept = keptRecalls(recalls, result.snapshot.checkpoints);
          if (kept.length < recalls.length) {
            yield* state.storage.put("revs", { ...(yield* revs), recalls: kept });
          }
        }
        if (!result.changed) return;
        const rows: Record<string, ViewEntry> = {};
        for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
        // The key's input log: every delivery it applied, in order, with what it emitted.
        const accepted = result.inputs;
        const inputs = (yield* state.storage.get<number>("in-seq")) ?? 0;
        const log: Record<string, ViewInput> = {};
        accepted.forEach((input, index) => {
          log[`in:${pad(inputs + index + 1)}`] = input;
        });
        if (accepted.length > 0) yield* state.storage.put(log);
        yield* state.storage.put("in-seq", inputs + accepted.length);
        yield* state.storage.put("snapshot", result.snapshot);
        if (result.entries.length > 0) yield* state.storage.put(rows);
        const live = yield* Backfill.routeCommit(
          sourceFor(key),
          kit.targets,
          yield* state.storage.get<Routed>("routed"),
          before.seq,
          result.snapshot.seq,
          result.downstream,
        );
        yield* state.storage.put("routed", live.routed);
        yield* outbox.stage(live.send);
        after.push(
          broadcast(({ key, subscription }) =>
            Effect.gen(function* () {
              // A subscriber behind this commit's first entry reads the gap from storage.
              const first = result.entries[0]?.seq ?? Infinity;
              const entries =
                subscription.mode === "events" && subscription.cursor < first - 1
                  ? yield* entriesAfter(subscription.cursor)
                  : result.entries;
              return yield* kit.push(key, subscription, result.snapshot, entries);
            }),
          ),
        );
        if (live.send.length > 0) after.push(outbox.kick);
      }).pipe(kit.observe(key, arrived));
    /**
     * Take the revisions a source has sent for one rewrite: fold the key's
     * inputs again with them, and tell its own consumers what changed among
     * its entries. Callers hold the exclusive section and its transaction.
     */
    const settle = (key: string, root: string, source: string) =>
      Effect.gen(function* () {
        yield* reset;
        const before = yield* read;
        const held = yield* revs;
        const pending = new Map(
          (yield* allRows<Delivery>(state.storage, "rev:")).map(
            ([, revised]) => [revisionKey(revised.source, revised.seq), revised] as const,
          ),
        );
        // Called once the revisions still held are stored again.
        const note = (sent: ReadonlyArray<Revised>) =>
          Effect.gen(function* () {
            const row = `revised:${root}|${source}`;
            const waiting = `rev-wait:${root}|${source}`;
            const all = mergeRevised(
              mergeRevised(
                (yield* state.storage.get<ReadonlyArray<Revised>>(row)) ?? [],
                (yield* state.storage.get<ReadonlyArray<Revised>>(waiting)) ?? [],
              ),
              sent,
            );
            // A revision still held, for an event yet to arrive: not all taken yet.
            if (yield* awaits(root, source)) return yield* state.storage.put(waiting, all);
            yield* state.storage.delete(waiting);
            yield* state.storage.put(row, all);
          });
        let inputs: ReadonlyArray<StoredViewInput> = (yield* allRows<StoredViewInput>(
          state.storage,
          "in:",
        )).map(([, row]) => row);
        // Rows stored before entries were tracked: fold them as they are, to learn each one's entries.
        if (inputs.some((row) => !("delivery" in row))) {
          inputs = (yield* kit.refold(key, { snapshot: emptySnapshot, top: 0 }, inputs)).inputs;
        }
        // The rewrite itself, for what the key kept of events its source no longer holds.
        const recall = recallOf(pending, source);
        if (recall !== undefined) pending.delete(revisionKey(source, 0));
        const recalls =
          recall === undefined
            ? held.recalls
            : keptRecalls([...(held.recalls ?? []), recall], before.checkpoints);
        const recalled =
          recall === undefined
            ? { rows: inputs, changed: false }
            : yield* kit.recall(key, recall, inputs);
        const taken = reviseInputs(recalled.rows, pending, before.checkpoints);
        // The revisions of events still to arrive stay.
        yield* clearPrefixes(["rev:"]);
        yield* putRows(
          state.storage,
          [...taken.left.values()].map(
            (revised) => [revisionRow(revised.source, revised.seq), revised] as const,
          ),
        );
        if (!taken.changed && !recalled.changed) {
          yield* state.storage.put("revs", { ...held, pending: taken.left.size, recalls });
          return yield* note([]);
        }
        const folded = yield* kit.refold(key, { snapshot: emptySnapshot, top: 0 }, taken.rows);
        const entries = (yield* allRows<ViewEntry>(state.storage, "entry:")).map(
          ([, entry]) => entry,
        );
        const changes = entryChanges(entries, folded.entries);
        const snapshot = refolded(before, folded.snapshot, folded.top);
        yield* clearPrefixes(["in:"]);
        yield* putRows(
          state.storage,
          folded.inputs.map((input, index) => [`in:${pad(index + 1)}`, input] as const),
        );
        yield* state.storage.put("in-seq", folded.inputs.length);
        const removed = changes.filter((change) => change.after === undefined);
        if (removed.length > 0) {
          for (const batch of Arr.chunksOf(removed, 128)) {
            yield* state.storage.delete(batch.map((change) => `entry:${pad(change.seq)}`));
          }
        }
        yield* putRows(
          state.storage,
          changes.flatMap((change) =>
            change.after === undefined ? [] : [[`entry:${pad(change.seq)}`, change.after] as const],
          ),
        );
        yield* state.storage.put("snapshot", snapshot);
        // An entry it had is revised; one it now emits besides is new to its consumers.
        const stamped = stampRevisions(
          { origin: kit.name, id: key },
          root,
          held.n,
          yield* kit.revise(
            key,
            root,
            changes.filter((change) => change.seq <= before.seq),
          ),
          yield* Clock.currentTimeMillis,
        );
        const added = (yield* kit.revise(
          key,
          root,
          changes.filter((change) => change.seq > before.seq),
        )).map(withoutRevision);
        const live = yield* Backfill.routeCommit(
          sourceFor(key),
          kit.targets,
          yield* state.storage.get<Routed>("routed"),
          before.seq,
          snapshot.seq,
          added,
        );
        yield* state.storage.put("routed", live.routed);
        yield* state.storage.put("revs", {
          ...held,
          pending: taken.left.size,
          n: stamped.last,
          recalls,
        } satisfies ViewRevisions);
        yield* outbox.stage([...stamped.deliveries, ...live.send]);
        yield* note(stamped.sent);
        after.push(broadcast(({ key, subscription }) => kit.push(key, subscription, snapshot, [])));
        after.push(outbox.kick);
      });
    /**
     * Take revisions from a source: hold each until its source's `done`.
     * Callers hold the exclusive section and its transaction.
     */
    const revise = (key: string, revisions: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        for (const delivery of revisions) {
          // For an earlier generation: sent by an instance still on older code.
          if ((delivery.target.generation ?? 0) < kit.generation) continue;
          const revision = delivery.revision!;
          const held = yield* revs;
          if (revision.n <= (held.taken[delivery.source] ?? 0)) continue;
          const taken = { ...held.taken, [delivery.source]: revision.n };
          if (revision.done) {
            yield* state.storage.put("revs", { ...held, taken });
            yield* settle(key, revision.root, delivery.source);
            continue;
          }
          yield* state.storage.put(revisionRow(delivery.source, delivery.seq), delivery);
          yield* state.storage.put("revs", { ...held, taken, pending: held.pending + 1 });
        }
      });
    const flushAfter = Effect.suspend(() => {
      const pending = after;
      after = [];
      return Effect.forEach(pending, (effect) => effect, { discard: true });
    });

    // This key as a backfill consumer (it buffers and merges history) and source.
    let consumer: Backfill.Consumer | undefined;
    let source: Backfill.Source | undefined;
    const runtime = yield* backfillRuntime(
      random,
      (id): Effect.Effect<void, never, ObjectState | RuntimeContext> =>
        Effect.flatMap(state.storage.get<string>(ID_KEY), (key) => {
          if (id.startsWith("bf-scan:")) return scannerFor().run(id);
          if (id.startsWith("drive:")) return runFor().run(id);
          if (key === undefined) return Effect.void;
          if (id === "bf-flush") return sourceFor(key).flush;
          if (id === REGISTER_JOB)
            return registerJob(net, { source: kit.name, id: key }, sourceFor(key), runtime.jobs);
          if (id.startsWith("bf-merge:"))
            // Listed before the merge writes its first entry, in the key's own job: its
            // sources' messages don't wait on the directory.
            return ensureRegistered(net, { source: kit.name, id: key }).pipe(
              Effect.andThen(consumerFor(key).merge(id.slice("bf-merge:".length))),
              Effect.catchCause(() => runtime.jobs.schedule(id, REGISTER_RETRY_MS)),
            );
          return Effect.void;
        }),
    );
    const consumerFor = (key: string): Backfill.Consumer =>
      (consumer ??= Backfill.makeConsumer(runtime.storage, runtime.jobs, net, {
        key,
        target: () => target,
        singleSource: () => kit.singleSource,
        sources: () => planOf(target)?.sources ?? [],
        history: (ref, rows) => kit.history(target, ref.source, ref.id, rows),
        apply: (deliveries) => runtime.provide(Effect.orDie(apply(key, deliveries))),
        after: runtime.provide(flushAfter),
      }));
    // An object of this class named for a source instance scans it (see `scannerName`).
    let scanner: Backfill.Scanner | undefined;
    const scannerFor = (): Backfill.Scanner =>
      (scanner ??= Backfill.makeScanner(runtime.storage, runtime.jobs, net, {
        route: (target, ref, rows) => kit.history(target, ref.source, ref.id, rows),
      }));
    // An object of this class named `RUN_ROOT` drives the run; others relay it.
    let run: Backfill.Run | undefined;
    const runFor = (): Backfill.Run =>
      (run ??= Backfill.makeRun(runtime.storage, runtime.jobs, net, {
        waitMillis: RELAY_ROOT_WAIT_MS,
        againMillis: 1_000,
      }));
    const relay = Backfill.makeRelay(net);
    const sourceFor = (key: string): Backfill.Source =>
      (source ??= Backfill.makeSource(runtime.storage, runtime.jobs, net, {
        ref: {
          source: kit.name,
          id: key,
          ...(kit.generation > 0 ? { generation: kit.generation } : {}),
        },
        singleSource: (target) => planOf(target)?.singleSource === true,
        model,
        targets: () => kit.targets,
        log: (after, limit) =>
          runtime.provide(
            state.storage
              .list<ViewEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}`, limit })
              .pipe(Effect.map((rows) => [...rows.values()])),
          ),
        version: runtime.provide(Effect.map(read, (snapshot) => snapshot.seq)),
        routed: runtime.provide(state.storage.get<Routed>("routed")),
        markLive: (target) =>
          runtime.provide(
            Effect.gen(function* () {
              const { seq } = yield* read;
              const routed = yield* state.storage.get<Routed>("routed");
              yield* state.storage.put("routed", { ...routed, [target]: seq });
            }),
          ),
      }));

    /**
     * A key of a view keyed by its one aggregate reads its history from that
     * instance (if it hasn't yet) before it serves it.
     */
    const filled = (key: string) =>
      Effect.suspend(() => {
        const catchUp = kit.catchUp;
        if (catchUp === undefined) return Effect.void;
        return Effect.gen(function* () {
          yield* state.storage.put(ID_KEY, key);
          yield* consumerFor(key)
            .start(target, { source: catchUp.source, id: key }, 20_000)
            .pipe(Effect.repeat({ until: (started) => started === "settled", times: 5 }));
        });
      });
    return {
      receive: (key: string, arrived: ReadonlyArray<Delivery>) =>
        reportDefects(
          Effect.gen(function* () {
            // Saved before anything else: the key's backfill jobs find it by this id.
            if ((yield* state.storage.get<string>(ID_KEY)) === undefined)
              yield* state.storage.put({ [ID_KEY]: key });
            // A rewrite's revisions are taken apart from the key's other inputs.
            const revisions = arrived.filter((delivery) => delivery.revision !== undefined);
            if (revisions.length > 0) {
              yield* exclusively(state.storage.transaction(revise(key, revisions)));
              yield* flushAfter;
            }
            const deliveries = arrived.filter((delivery) => delivery.revision === undefined);
            if (deliveries.length === 0) return;
            // While a backfill runs, the key buffers deliveries and merges them in order.
            if (!(yield* consumerFor(key).admit(target, deliveries))) return;
            // Listed in the directory after the call returns, not before its first entry.
            yield* exclusively(
              state.storage.transaction(
                Effect.andThen(listAfterCommit(runtime.jobs, key), apply(key, deliveries)),
              ),
            );
            yield* flushAfter;
          }),
        ),
      read: () => reportDefects(read),
      after: (after: number) => reportDefects(entriesAfter(after)),
      page: (range: ListRange | undefined) => reportDefects(entriesIn(range)),
      revised: (root: string, source: string) =>
        reportDefects(
          state.storage
            .get<ReadonlyArray<Revised>>(`revised:${root}|${source}`)
            .pipe(Effect.map((sent) => sent ?? null)),
        ),
      // The backfill protocol, as a source, a consumer and a scanner.
      ...scannerRpc(() => scannerFor()),
      ...runRpc(relay, runFor),
      // Read as a source, a key keyed by its aggregate has its own history
      // first: a view or projection catching up never sees it still filling.
      bfLog: (key: string, after: number, limit: number) =>
        reportDefects(Effect.andThen(filled(key), sourceFor(key).log(after, limit))),
      bfCursor: (key: string, target: string) =>
        reportDefects(Effect.andThen(filled(key), sourceFor(key).cursor(target))),
      bfRead: (key: string, target: string, reader: string, after: number, limit: number) =>
        reportDefects(
          Effect.andThen(filled(key), sourceFor(key).read(target, reader, after, limit)),
        ),
      bfHandoff: (key: string, target: string, consumerKey: string, through: number) =>
        reportDefects(
          Effect.andThen(filled(key), sourceFor(key).handoff(target, consumerKey, through)),
        ),
      bfStart: (key: string, target: string, ref: Backfill.SourceRef, waitMillis?: number) =>
        reportDefects(
          Effect.gen(function* () {
            yield* state.storage.put(ID_KEY, key);
            return yield* consumerFor(key).start(target, ref, waitMillis);
          }),
        ),
      // The key lists itself in its merge job, before its first entry.
      bfPush: (key: string, target: string, deliveries: ReadonlyArray<Delivery>) =>
        reportDefects(
          Effect.gen(function* () {
            yield* state.storage.put(ID_KEY, key);
            yield* consumerFor(key).push(target, deliveries);
          }),
        ),
      bfConsumerReady: (key: string, target: string, waitMillis?: number) =>
        reportDefects(
          Effect.gen(function* () {
            yield* state.storage.put(ID_KEY, key);
            return yield* consumerFor(key).ready(target, waitMillis);
          }),
        ),
      // A live read of this key: accept its WebSocket, then push on every commit.
      fetch: accept(
        (key, subscription) =>
          Effect.gen(function* () {
            const snapshot = yield* read;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, snapshot, entries);
          }),
        expiry,
      ),
      ...socketHandlers,
    };
  });

/** The revisions a view key holds and has taken. */
interface ViewRevisions {
  /** How many `rev:` rows it holds. */
  readonly pending: number;
  /** The last revision it took from each source. */
  readonly taken: Readonly<Record<string, number>>;
  /** The revisions it has sent its own consumers. */
  readonly n: number;
  /** Rewrites of events its sources removed, held for those yet to arrive (see `keptRecalls`). */
  readonly recalls?: ReadonlyArray<Delivery>;
}

const policyObject = (kit: PolicyKit) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    // Detached: a delivery arrives inside the sender's drain, so draining it
    // here would run the policy's commands one call deeper than the sender.
    const inbox = yield* queue<Delivery>("inbox", kit.run, { detached: true });
    return {
      receive: (delivery: Delivery) =>
        reportDefects(
          Effect.gen(function* () {
            // A rewrite's revision is the past changed: what a policy did has happened.
            if (delivery.revision !== undefined) return;
            const id = `${delivery.source}:${delivery.seq}`;
            const accepted = yield* exclusively(
              state.storage.transaction(
                Effect.gen(function* () {
                  if (yield* state.storage.get(`seen:${id}`)) return false;
                  yield* state.storage.put(`seen:${id}`, true);
                  yield* inbox.stage([delivery]);
                  return true;
                }),
              ),
            );
            if (accepted) yield* inbox.kick;
          }),
        ),
    };
  });

/**
 * The stored progress of one projection key: scalars only, so writing it
 * costs the same however many sources the key hears from. Per-source cursors
 * are rows of their own, under {@link INTAKE}, {@link CHECKPOINT} and
 * {@link TAKEN}.
 */
interface ProjectionMeta {
  readonly key: string | null;
  /** Inputs accepted into the log. */
  readonly accepted: number;
  /** Inputs handled. */
  readonly processed: number;
  /** The projection's generation the log was built by: an earlier one starts over. */
  readonly generation?: number;
  /** How many revisions it holds (`rev:` rows) of events it has not been given yet. */
  readonly pending?: number;
  /** Written by earlier code: the per-source maps, moved to rows on the next write. */
  readonly intake?: Readonly<Record<string, number>>;
  readonly checkpoints?: Readonly<Record<string, number>>;
  readonly taken?: Readonly<Record<string, number>>;
}

const emptyProjectionMeta: ProjectionMeta = {
  key: null,
  accepted: 0,
  processed: 0,
};

/** `intake:<source>`: the last accepted `seq` of a source. Duplicates are dropped on arrival. */
const INTAKE = "intake:";
/** `ckpt:<source>`: the last handled `seq` of a source. */
const CHECKPOINT = "ckpt:";
/** `taken:<source>`: the last revision taken from a source. */
const TAKEN = "taken:";

/** How long a failed or interrupted run waits before it is retried. */
const PROJECTION_RETRY_MS = 10_000;

const projectionObject = (
  kit: ProjectionKit,
  net: Backfill.Network,
  planOf: PlanOf,
  random: Random,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    // A log built by an earlier generation of the projection reads as empty.
    const readMeta = state.storage
      .get<ProjectionMeta>("meta")
      .pipe(
        Effect.map((meta) =>
          meta === undefined || (meta.generation ?? 0) < kit.generation
            ? { ...emptyProjectionMeta, generation: kit.generation }
            : meta,
        ),
      );
    /** Start a log built by an earlier generation over. */
    const reset = Effect.gen(function* () {
      const meta = yield* state.storage.get<ProjectionMeta>("meta");
      if (meta === undefined || (meta.generation ?? 0) >= kit.generation) return;
      yield* clearPrefixes(["in:", "rev:", "rev-wait:", "settled:", INTAKE, CHECKPOINT, TAKEN]);
      yield* state.storage.delete("meta");
    });
    /**
     * Move the per-source maps an earlier version kept in `meta` to rows,
     * once. Callers hold the exclusive section and its transaction.
     */
    const upgrade = (meta: ProjectionMeta) =>
      Effect.gen(function* () {
        if (
          meta.intake === undefined &&
          meta.checkpoints === undefined &&
          meta.taken === undefined
        ) {
          return meta;
        }
        const { intake = {}, checkpoints = {}, taken = {}, ...scalars } = meta;
        const rows: Array<readonly [string, number]> = [];
        for (const [source, seq] of Object.entries(intake)) rows.push([INTAKE + source, seq]);
        for (const [source, seq] of Object.entries(checkpoints)) {
          rows.push([CHECKPOINT + source, seq]);
        }
        for (const [source, n] of Object.entries(taken)) rows.push([TAKEN + source, n]);
        yield* putRows(state.storage, rows);
        yield* state.storage.put("meta", scalars);
        return scalars;
      });
    /** A per-source cursor, or 0. Read after `upgrade`, so the rows are all there is. */
    const cursor = (prefix: string, source: string) =>
      Effect.map(state.storage.get<number>(prefix + source), (n) => n ?? 0);
    /**
     * The last handled `seq` per source: every source's, or only `sources`'.
     * A key not yet upgraded still keeps them in `meta`, and its rows win.
     */
    const checkpointsOf = (sources?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const meta = yield* readMeta;
        // Nothing accepted in this generation (an earlier one's rows read as empty).
        if (meta.key === null) return {};
        const legacy = meta.checkpoints ?? {};
        if (sources === undefined) {
          const rows = yield* allRows<number>(state.storage, CHECKPOINT);
          return {
            ...legacy,
            ...Object.fromEntries(rows.map(([row, seq]) => [row.slice(CHECKPOINT.length), seq])),
          };
        }
        const seqs = yield* Effect.forEach(sources, (source) =>
          Effect.map(
            state.storage.get<number>(CHECKPOINT + source),
            (seq) => seq ?? legacy[source],
          ),
        );
        return Object.fromEntries(
          sources.flatMap((source, i) => (seqs[i] === undefined ? [] : [[source, seqs[i]]])),
        );
      });
    const size = kit.options.batch?.size ?? 1;
    const waitMillis = kit.options.batch?.waitMillis ?? 0;
    const lease = "drain-lease";
    const acquire = exclusively(acquireLease(state, lease));
    // Re-run the drain later: when a short batch has waited long enough, or after a failure.
    let wake: (at: number) => Effect.Effect<void> = () => Effect.void;
    // Each input's backstop advances this cursor: once an input arrives, a
    // drain waiting for it from inside its own callback waits the batch
    // wait, not that callback's retry backoff.
    const advance = Effect.gen(function* () {
      const progress = ((yield* state.storage.get<number>("drain-progress")) ?? 0) + 1;
      yield* state.storage.put("drain-progress", progress);
      return progress;
    });
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Durable Object provides its state and RuntimeContext on every event
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      const held = yield* acquire;
      // Held by another drain, or by one whose instance died: look again once it expires.
      if (held !== undefined) return yield* wake(held);
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          while (true) {
            const meta = yield* readMeta;
            if (meta.key === null || meta.processed >= meta.accepted) return;
            const rows = yield* state.storage.list<Accepted>({
              prefix: "in:",
              start: `in:${pad(meta.processed + 1)}`,
              limit: size,
            });
            const run = [...rows.values()];
            if (run.length === 0) return;
            if (
              run.length < size &&
              waitMillis > 0 &&
              (yield* Clock.currentTimeMillis) - run[0]!.at < waitMillis
            ) {
              return yield* wake(run[0]!.at + waitMillis);
            }
            yield* kit.run(meta.key, run);
            yield* exclusively(
              state.storage.transaction(
                Effect.gen(function* () {
                  const current = yield* upgrade(yield* readMeta);
                  const handled: Record<string, number> = {};
                  for (const { delivery } of run) {
                    handled[delivery.source] = Math.max(
                      handled[delivery.source] ?? 0,
                      delivery.seq,
                    );
                    // Every revision of a rewrite from this source is handled.
                    if (delivery.revision?.done) {
                      yield* state.storage.put(
                        `settled:${delivery.revision.root}|${delivery.source}`,
                        true,
                      );
                    }
                  }
                  // A source's row moves forward only: a rewrite's revisions
                  // carry the `seq` of events handled before, and its `done` 0.
                  const ahead: Array<readonly [string, number]> = [];
                  for (const [source, seq] of Object.entries(handled)) {
                    if (seq > (yield* cursor(CHECKPOINT, source))) {
                      ahead.push([CHECKPOINT + source, seq]);
                    }
                  }
                  yield* putRows(state.storage, ahead);
                  yield* state.storage.put("meta", {
                    ...current,
                    processed: run[run.length - 1]!.position,
                  } satisfies ProjectionMeta);
                  // A handled input is not kept: the store the handler wrote has it.
                  yield* state.storage.delete(rows.size === 0 ? [] : [...rows.keys()]);
                }),
              ),
            );
          }
        }),
      );
      yield* state.storage.delete(lease).pipe(Effect.ignore);
      if (exit._tag === "Failure") {
        yield* Effect.logError(`projection ${kit.name} failed; retrying`, exit.cause);
        yield* wake((yield* Clock.currentTimeMillis) + PROJECTION_RETRY_MS);
      }
    }) as Effect.Effect<void>;
    const callback = yield* makeCallback("domain:projection", () => drain);
    wake = (at) =>
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Durable Object provides RuntimeContext on every event
      callback.schedule("drain", { at, payload: {} }).pipe(Effect.ignore) as Effect.Effect<void>;
    /**
     * Accept a delivery into the key's log, once. Callers hold the exclusive
     * section and its transaction; `true` when it was new.
     */
    /** Whether the key still holds a revision of `root` from `source`, for an event yet to arrive. */
    const awaits = (root: string, source: string) =>
      Effect.map(state.storage.list<Delivery>({ prefix: `rev:${source}|` }), (rows) =>
        awaitsRevision(rows.values(), root, source),
      );
    /** Append a row to the key's log. Callers hold the exclusive section and its transaction. */
    const append = (key: string, meta: ProjectionMeta, delivery: Delivery) =>
      Effect.gen(function* () {
        const position = meta.accepted + 1;
        yield* state.storage.put(`in:${pad(position)}`, {
          position,
          delivery,
          at: yield* Clock.currentTimeMillis,
        } satisfies Accepted);
        // The backstop: handled even if this instance dies before the drain runs.
        yield* callback.schedule("drain", {
          after: `${Math.max(waitMillis, PROJECTION_RETRY_MS)} millis`,
          payload: {},
          progress: yield* advance,
        });
        return { ...meta, key, accepted: position } satisfies ProjectionMeta;
      });
    /**
     * Take a rewrite's revision of an event. One the key has not been given
     * yet is held until it arrives; one still waiting in the log is swapped
     * there, unless a drain may be handling it; one already handled goes
     * into the log as a revision, for the `rewrite` handler. Callers hold the
     * exclusive section and its transaction; `true` when the log grew.
     */
    const reviseIntake = (key: string, delivery: Delivery) =>
      Effect.gen(function* () {
        if ((delivery.target.generation ?? 0) < kit.generation) return false;
        yield* reset;
        const revision = delivery.revision!;
        const meta = yield* upgrade(yield* readMeta);
        if (revision.n <= (yield* cursor(TAKEN, delivery.source))) return false;
        /** Write `meta` with the source's taken revision (and any other rows) in one put. */
        const save = (next: ProjectionMeta, rows: Record<string, number> = {}) =>
          state.storage.put({ meta: next, [TAKEN + delivery.source]: revision.n, ...rows });
        if (revision.done) {
          // Held while a revision of it waits for its event: handled after that.
          if (yield* awaits(revision.root, delivery.source)) {
            yield* state.storage.put(`rev-wait:${revision.root}|${delivery.source}`, delivery);
            yield* save({ ...meta, key } satisfies ProjectionMeta);
            return false;
          }
          yield* save(yield* append(key, meta, delivery));
          return true;
        }
        const accepted = yield* cursor(INTAKE, delivery.source);
        // Newly given to this key: an ordinary input, late.
        if (revision.before === undefined) {
          yield* save(yield* append(key, meta, withoutRevision(delivery)), {
            [INTAKE + delivery.source]: Math.max(accepted, delivery.seq),
          });
          return true;
        }
        // Given to the key, and yet to arrive: taken when it does.
        if (delivery.seq > accepted) {
          yield* state.storage.put(revisionRow(delivery.source, delivery.seq), delivery);
          yield* save({
            ...meta,
            key,
            pending: (meta.pending ?? 0) + 1,
          } satisfies ProjectionMeta);
          return false;
        }
        // A drain under way may be handling a waiting input: it is then left as it is.
        const leased = yield* state.storage.get<number>(lease);
        const idle = leased === undefined || leased <= (yield* Clock.currentTimeMillis);
        if (idle) {
          const waiting = yield* state.storage.list<Accepted>({
            prefix: "in:",
            start: `in:${pad(meta.processed + 1)}`,
          });
          for (const [row, accepted] of waiting) {
            const input = accepted.delivery;
            if (
              input.revision !== undefined ||
              input.source !== delivery.source ||
              input.seq !== delivery.seq
            ) {
              continue;
            }
            yield* state.storage.put(row, {
              ...accepted,
              delivery: revision.gone
                ? { ...delivery, revision: { root: revision.root, n: revision.n, gone: true } }
                : withoutRevision(delivery),
            } satisfies Accepted);
            yield* save({ ...meta, key } satisfies ProjectionMeta);
            return false;
          }
        }
        yield* save(yield* append(key, meta, delivery));
        return true;
      });
    const intake = (key: string, arrived: Delivery) =>
      Effect.gen(function* () {
        if (arrived.revision !== undefined) return yield* reviseIntake(key, arrived);
        let delivery = arrived;
        const sent = delivery.target.generation ?? 0;
        // For an earlier generation: sent by an instance still on older code.
        if (sent < kit.generation) return false;
        // Sent by newer code: fail, so the sender retries once this instance runs it.
        if (sent > kit.generation) {
          return yield* Effect.die(
            new Error(`${kit.name} received generation ${sent} but runs ${kit.generation}`),
          );
        }
        yield* reset;
        let meta = yield* upgrade(yield* readMeta);
        if ((yield* cursor(INTAKE, delivery.source)) >= delivery.seq) return false;
        meta = { ...meta, key };
        /** Write `meta` with the source's intake row in one put. */
        const save = (next: ProjectionMeta) =>
          state.storage.put({ meta: next, [INTAKE + delivery.source]: delivery.seq });
        // An event a rewrite changed before it got here arrives as it is now.
        if ((meta.pending ?? 0) > 0) {
          const row = revisionRow(delivery.source, delivery.seq);
          const revised = yield* state.storage.get<Delivery>(row);
          if (revised !== undefined) {
            yield* state.storage.delete(row);
            meta = { ...meta, pending: (meta.pending ?? 1) - 1 };
            if (!revised.revision?.gone) meta = yield* append(key, meta, withoutRevision(revised));
            // The last event a rewrite was waiting for: its `done` follows it in the log.
            const root = revised.revision!.root;
            const waiting = `rev-wait:${root}|${delivery.source}`;
            const done = yield* state.storage.get<Delivery>(waiting);
            if (done !== undefined && !(yield* awaits(root, delivery.source))) {
              yield* state.storage.delete(waiting);
              meta = yield* append(key, meta, done);
            }
            yield* save(meta);
            return true;
          }
        }
        yield* save(yield* append(key, meta, delivery));
        return true;
      });
    const target = targetId({
      kind: "projection",
      name: kit.name,
      ...(kit.generation > 0 ? { generation: kit.generation } : {}),
    });
    // This key as a backfill consumer: it buffers and merges history in order.
    let consumer: Backfill.Consumer | undefined;
    const runtime = yield* backfillRuntime(random, (id) =>
      id.startsWith("bf-scan:")
        ? scannerFor().run(id)
        : id.startsWith("drive:")
          ? runFor().run(id)
          : Effect.flatMap(state.storage.get<string>(ID_KEY), (key) =>
              key !== undefined && id.startsWith("bf-merge:")
                ? consumerFor(key).merge(id.slice("bf-merge:".length))
                : Effect.void,
            ),
    );
    // An object of this class named for a source instance scans it (see `scannerName`).
    let scanner: Backfill.Scanner | undefined;
    const scannerFor = (): Backfill.Scanner =>
      (scanner ??= Backfill.makeScanner(runtime.storage, runtime.jobs, net, {
        route: (target, ref, rows) => kit.history(target, ref.source, ref.id, rows),
      }));
    // An object of this class named `RUN_ROOT` drives the run; others relay it.
    let run: Backfill.Run | undefined;
    const runFor = (): Backfill.Run =>
      (run ??= Backfill.makeRun(runtime.storage, runtime.jobs, net, {
        waitMillis: RELAY_ROOT_WAIT_MS,
        againMillis: 1_000,
      }));
    const relay = Backfill.makeRelay(net);
    const consumerFor = (key: string): Backfill.Consumer =>
      (consumer ??= Backfill.makeConsumer(runtime.storage, runtime.jobs, net, {
        key,
        target: () => target,
        singleSource: () => kit.singleSource,
        sources: () => planOf(target)?.sources ?? [],
        history: (ref, rows) => kit.history(target, ref.source, ref.id, rows),
        apply: (deliveries) =>
          runtime.provide(
            Effect.orDie(Effect.forEach(deliveries, (d) => intake(key, d), { discard: true })),
          ),
        after: runtime.provide(state.waitUntil(drain.pipe(Effect.ignoreCause))),
      }));
    const keep = (key: string) => state.storage.put(ID_KEY, key);
    return {
      receive: (key: string, delivery: Delivery) =>
        reportDefects(
          Effect.gen(function* () {
            yield* keep(key);
            // A rewrite's revisions are taken apart from the key's other inputs.
            if (
              delivery.revision === undefined &&
              !(yield* consumerFor(key).admit(target, [delivery]))
            ) {
              return;
            }
            const accepted = yield* exclusively(state.storage.transaction(intake(key, delivery)));
            if (accepted) yield* state.waitUntil(drain.pipe(Effect.ignoreCause));
          }),
        ),
      checkpoints: (sources?: ReadonlyArray<string>) => reportDefects(checkpointsOf(sources)),
      revised: (root: string, source: string) =>
        reportDefects(
          state.storage
            .get<boolean>(`settled:${root}|${source}`)
            .pipe(Effect.map((settled) => settled === true)),
        ),
      // The backfill protocol, as a consumer and a scanner.
      ...scannerRpc(() => scannerFor()),
      ...runRpc(relay, runFor),
      bfPush: (key: string, target: string, deliveries: ReadonlyArray<Delivery>) =>
        reportDefects(keep(key).pipe(Effect.andThen(consumerFor(key).push(target, deliveries)))),
      bfConsumerReady: (key: string, target: string, waitMillis?: number) =>
        reportDefects(keep(key).pipe(Effect.andThen(consumerFor(key).ready(target, waitMillis)))),
      bfStart: (key: string, target: string, ref: Backfill.SourceRef, waitMillis?: number) =>
        reportDefects(
          keep(key).pipe(Effect.andThen(consumerFor(key).start(target, ref, waitMillis))),
        ),
    };
  });

/** Where a stream key indexes the entries it appended for one source event. */
const fromPrefix = (source: string, seq: number) => `from:${source}|${pad(seq)}:`;

const streamObject = (kit: StreamKit) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const expiry = yield* makeExpiry;
    const readMeta = state.storage
      .get<StreamMeta>("meta")
      .pipe(Effect.map((meta) => meta ?? emptyStreamMeta));
    const entriesAfter = (after: number) =>
      state.storage
        .list<StreamEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
        .pipe(Effect.map((rows) => [...rows.values()]));
    const entriesIn = (range: ListRange | undefined) =>
      state.storage
        .list<StreamEntry>(entryRange(range))
        .pipe(Effect.map((rows) => [...rows.values()]));
    const latest = (meta: StreamMeta) =>
      meta.seq === 0 ? Effect.undefined : state.storage.get<StreamEntry>(`entry:${pad(meta.seq)}`);
    return {
      append: (key: string, write: StreamWrite) =>
        Effect.gen(function* () {
          const before = yield* readMeta;
          const { meta, appends } = admitStreamWrite(before, write);
          if (!appends) {
            // A rebuilt writer's first write still starts its generation.
            if (meta !== before) yield* state.storage.put("meta", meta);
            return;
          }
          const added: Array<StreamEntry> = write.events.map((event, index) => {
            const seq = meta.seq + index + 1;
            return {
              seq,
              event,
              envelope: {
                id: key,
                stream: `${kit.name}/${key}`,
                seq,
                at: write.at,
                commandId: write.commandId,
              },
              from: { source: write.source, seq: write.sourceSeq },
            };
          });
          const next: StreamMeta = { ...meta, seq: meta.seq + added.length };
          yield* state.storage.transaction(
            Effect.gen(function* () {
              const rows: Record<string, StreamEntry | number> = {};
              for (const entry of added) {
                rows[`entry:${pad(entry.seq)}`] = entry;
                // Found again by the source event it was appended for, should that be rewritten.
                rows[`${fromPrefix(write.source, write.sourceSeq)}${pad(entry.seq)}`] = entry.seq;
              }
              if (added.length > 0) yield* putRows(state.storage, Object.entries(rows));
              yield* state.storage.put("meta", next);
            }),
          );
          if (added.length === 0) return;
          yield* broadcast(({ key, subscription }) =>
            Effect.gen(function* () {
              // A subscriber behind this append's first entry reads the gap from storage.
              const entries =
                subscription.mode === "events" && subscription.cursor < added[0]!.seq - 1
                  ? yield* entriesAfter(subscription.cursor)
                  : added;
              return yield* kit.push(key, subscription, next, entries, added[added.length - 1]);
            }),
          );
        }).pipe(exclusively, reportDefects),
      advance: (handled: StreamHandled) =>
        Effect.gen(function* () {
          yield* state.storage.put("meta", advanceStreamMeta(yield* readMeta, handled));
        }).pipe(exclusively, reportDefects),
      revise: (key: string, revision: StreamRevision) =>
        state.storage
          .transaction(
            Effect.gen(function* () {
              const meta = yield* readMeta;
              const prefix = fromPrefix(revision.source, revision.sourceSeq);
              const seqs = [...(yield* state.storage.list<number>({ prefix })).values()];
              const matching = (yield* Effect.forEach(seqs, (seq) =>
                state.storage.get<StreamEntry>(`entry:${pad(seq)}`),
              )).filter((entry): entry is StreamEntry => entry !== undefined);
              const revised = reviseEntries(kit.name, key, meta.seq, matching, revision);
              if (revised.put.length === 0 && revised.removed.length === 0) return;
              if (revised.removed.length > 0) {
                yield* state.storage.delete(
                  revised.removed.flatMap((seq) => [`entry:${pad(seq)}`, `${prefix}${pad(seq)}`]),
                );
              }
              yield* putRows(
                state.storage,
                revised.put.flatMap(
                  (entry): ReadonlyArray<readonly [string, StreamEntry | number]> => [
                    [`entry:${pad(entry.seq)}`, entry],
                    [`${prefix}${pad(entry.seq)}`, entry.seq],
                  ],
                ),
              );
              yield* state.storage.put("meta", { ...meta, seq: revised.top });
            }),
          )
          .pipe(exclusively, reportDefects),
      read: () => reportDefects(readMeta),
      after: (after: number) => reportDefects(entriesAfter(after)),
      page: (range: ListRange | undefined) => reportDefects(entriesIn(range)),
      // A live read of this key: accept its WebSocket, then push on every append.
      fetch: accept(
        (key, subscription) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, meta, entries, yield* latest(meta));
          }),
        expiry,
      ),
      ...socketHandlers,
    };
  });

/** How often a subscription re-reads the Durable Object that owns a key. */
const POLL = Schedule.spaced("300 millis");

/** Entries after a cursor, then new ones, by polling the object that owns them. */
const pollAfter = <A>(
  from: number,
  read: (cursor: number) => Effect.Effect<ReadonlyArray<A>>,
  seqOf: (entry: A) => number,
): Stream.Stream<A> =>
  Stream.suspend(() => {
    let first = true;
    return Stream.paginate(from, (cursor: number) => {
      const poll = read(cursor);
      const next = first ? poll : Effect.delay(poll, "300 millis");
      first = false;
      return Effect.map(
        next,
        (fresh) =>
          [
            fresh,
            Option.some(fresh.length > 0 ? seqOf(fresh[fresh.length - 1]!) : cursor),
          ] as const,
      );
    });
  });

/**
 * An object's methods run later, per call, and look up the instance's state
 * then: give each one the state the instance was built with.
 */
const bindState = (impl: ObjectImpl): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const record = yield* impl;
    const bound: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record)) {
      bound[name] =
        typeof value === "function"
          ? (...args: ReadonlyArray<unknown>) => {
              const result = (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
              return Effect.isEffect(result)
                ? Effect.provideService(result, ObjectState, state)
                : result;
            }
          : Effect.isEffect(value)
            ? Effect.provideService(value, ObjectState, state)
            : value;
    }
    return bound;
  });

/** Where a host keeps a Vault's keys: the class `Domain.VaultKeys`, one object per subject. */
const VAULT: HostedModel = { modelName: "Domain", id: {}, sagas: [], legacyData: false };

/**
 * One subject's key, in its object's own storage. The first key stored
 * wins, as `KeyStore.create` says.
 */
const keyObject: ObjectImpl = Effect.succeed({
  keyGet: () =>
    reportDefects(
      Effect.flatMap(ObjectState, ({ storage }) =>
        Effect.map(storage.get<string>("key"), (key) => key ?? null),
      ),
    ),
  keyCreate: (key: string) =>
    reportDefects(
      Effect.flatMap(ObjectState, ({ storage }) =>
        storage.transaction(
          Effect.gen(function* () {
            const existing = yield* storage.get<string>("key");
            if (existing !== undefined) return existing;
            yield* storage.put("key", key);
            return key;
          }),
        ),
      ),
    ),
  keyDelete: () =>
    reportDefects(
      Effect.flatMap(ObjectState, ({ storage }) => Effect.as(storage.delete("key"), null)),
    ),
});

/** Every runtime's claims, by host name; a process outside any runtime has one of its own. */
const runtimeClaims = new WeakMap<object, Map<string, object>>();
const noRuntime = {};

/**
 * The claim key of a host named `name` (a pool, or a class of objects) in
 * the runtime building the model. Two models with one name fail in one
 * runtime; a redeploy builds a new runtime, so the model it hosts replaces
 * the old one even when both are built in one process (a test, or a reload
 * in dev).
 *
 * @internal
 */
export const runtimeClaim = (name: string): Effect.Effect<object> =>
  Effect.map(Effect.serviceOption(RuntimeContext), (context) => {
    const runtime = Option.getOrElse(context, () => noRuntime);
    let byName = runtimeClaims.get(runtime);
    if (byName === undefined) runtimeClaims.set(runtime, (byName = new Map()));
    let claim = byName.get(name);
    if (claim === undefined) byName.set(name, (claim = {}));
    return claim;
  });

/** The models each host hosts, by name. */
const claims = new WeakMap<object, ReturnType<typeof hostedModels>>();
const claimsOf = (key: object) => {
  let claim = claims.get(key);
  if (claim === undefined) claims.set(key, (claim = hostedModels({ release: false })));
  return claim;
};

/**
 * The Domain {@link Platform} over a host's Durable Objects. Every aggregate,
 * view, policy, projection and stream becomes a class of objects, declared
 * while the model's Layer is built; one object per aggregate id, per view,
 * projection or stream key, and per policy key.
 *
 * Commands to one instance run one at a time, and their events, state and
 * outbox commit together. Deliveries to views and policies are at least once
 * and in order per source, and survive restarts. A view or projection added
 * in a later deploy receives the history recorded before it: every instance
 * lists itself in a directory of objects, and a run reads it and gives each
 * key of the new consumer its sources' events.
 *
 * The workflow engine sagas run on is the host's to provide.
 */
export const makePlatform = <R>(
  host: Host<R>,
): Layer.Layer<Platform, never, R | SecureRandom.SecureRandom> =>
  Layer.effect(
    Platform,
    Effect.gen(function* () {
      // Factories run while the Domain's Layer is built, inside the host's
      // construction phase; declaring a class needs that context.
      const init = yield* captureContext<R>();
      const inInit = <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `init` is the host's context minus its Scope, which declaring needs none of
        Effect.provide(effect, init) as Effect.Effect<A, E>;
      const random = yield* SecureRandom.SecureRandom;
      const commitDecision = yield* TwoPhase.DecisionCommit;
      // Model names are unique per host, not per platform build: two different
      // models named alike would declare the same classes. The same model
      // hosted twice declares them again, which is harmless.
      const claim = claimsOf(yield* host.claimKey);
      const hosts = new Map<string, ModelHost>();
      // Everything of a model is its own: its objects, and its backfill's
      // directory and runs. Models that share a definition never share data.
      const hostFor = (hosted: HostedModel) =>
        Effect.gen(function* () {
          const object = (name: string, impl: ObjectImpl) =>
            host.declare(hosted, name, bindState(impl));
          // Every consumer in the model this isolate runs, set once the model is built.
          let model: ReadonlyArray<string> = [];
          let planOf: PlanOf = () => undefined;
          const consumerPlans: PlanOf = (target) => planOf(target);
          const current = () => model;
          // The objects the backfill protocol reaches: directory nodes, sources by
          // class, consumers by class.
          let directory: Namespace | undefined;
          const sources = new Map<string, Namespace>();
          const consumers = new Map<string, Namespace>();
          /** The decisions this code hosts: the instance a command reads first decides it. */
          const decisions = new Map<string, DecisionKit>();
          const nodeStub = (path: string) => directory!.getByName(`node:${path}`);
          /**
           * A class this code may not have declared. Code that hosts only
           * directory nodes never builds the model, so its maps are empty: it
           * still reaches every aggregate, view and projection this way.
           */
          const bound = (name: string): Namespace | undefined => host.lookup?.(hosted, name);
          /** The generation of each view in this code, as a source: its keys' class. */
          const viewGenerations = new Map<string, number>();
          /** A source's class: an aggregate's, or a view generation's (a rebuilt view's keys are its class's). */
          const sourceNamespace = (ref: Backfill.SourceRef) => {
            const view = consumerClass(
              "view",
              ref.source,
              ref.generation ?? viewGenerations.get(ref.source) ?? 0,
            );
            // A view this code hosts, or one named by its generation, is never an
            // aggregate. Ask for its class first: a host whose `lookup` reaches any
            // class name (one class multiplexing them all) can't tell them apart.
            if (ref.generation !== undefined || viewGenerations.has(ref.source)) {
              return sources.get(view) ?? bound(view);
            }
            return (
              sources.get(`${ref.source}Aggregate`) ??
              bound(`${ref.source}Aggregate`) ??
              sources.get(view) ??
              bound(view)
            );
          };
          const sourceObject = (namespace: Namespace, ref: Backfill.SourceRef) =>
            namespace.getByName(ref.id);
          /** A consumer's keys (`key`), or its run's root, relays and scanners (`run`): see `runClass`. */
          const consumerStub = (target: string, key: string, role: "key" | "run" = "key") => {
            const { kind, name } = Backfill.consumerOf(target);
            const keys = consumerClass(kind, name, generationOfTarget(target));
            const cls = role === "run" ? runClass(keys) : keys;
            return (consumers.get(cls) ?? bound(cls))?.getByName(key);
          };
          const consumerOf = (target: string, key: string, role: "key" | "run" = "key") => {
            const stub = consumerStub(target, key, role);
            return stub === undefined
              ? Effect.die(new Error(`backfill: ${target} isn't in the code this object runs yet`))
              : Effect.succeed(stub);
          };
          /** Runs this isolate has seen complete: a key asks once per isolate, not on every first delivery. */
          const complete = new Set<string>();
          const net: Backfill.Network = {
            node: {
              register: (path, ref) => unwrapDefects(nodeStub(path).register(path, ref)),
              child: (path, child) => unwrapDefects(nodeStub(path).child(path, child)),
              list: (path, after) => callOnce(nodeStub(path).list(path, after)),
            },
            source: {
              // A source no longer in the model has nothing to give.
              read: (ref, target, key, after, limit) => {
                const namespace = sourceNamespace(ref);
                return namespace
                  ? callOnce<Backfill.Read>(
                      sourceObject(namespace, ref).bfRead(ref.id, target, key, after, limit),
                    )
                  : Effect.succeed({ from: after, rows: [], handoff: "live" as const });
              },
              cursor: (ref, target) => {
                const namespace = sourceNamespace(ref);
                return namespace
                  ? callOnce<number>(sourceObject(namespace, ref).bfCursor(ref.id, target))
                  : Effect.succeed(0);
              },
              log: (ref, after, limit) => {
                const namespace = sourceNamespace(ref);
                return namespace
                  ? callOnce(sourceObject(namespace, ref).bfLog(ref.id, after, limit))
                  : Effect.succeed([]);
              },
              handoff: (ref, target, key, through) => {
                const namespace = sourceNamespace(ref);
                return namespace
                  ? callOnce(sourceObject(namespace, ref).bfHandoff(ref.id, target, key, through))
                  : Effect.succeed("live" as const);
              },
            },
            // A consumer this isolate can't reach runs code older than the announcement
            // (its class is new): fail the call, and the caller asks again once it can.
            consumer: {
              push: (target, key, deliveries) =>
                Effect.flatMap(consumerOf(target, key), (stub) =>
                  callOnce(stub.bfPush(key, target, deliveries)),
                ),
              ready: (target, key, waitMillis) =>
                Effect.flatMap(consumerOf(target, key), (stub) =>
                  callOnce(stub.bfConsumerReady(key, target, waitMillis)),
                ),
              start: (target, key, ref, waitMillis) =>
                Effect.flatMap(consumerOf(target, key), (stub) =>
                  callOnce(stub.bfStart(key, target, ref, waitMillis)),
                ),
            },
            // A source instance's scanner is an object of the consumer's own class: it has its routing.
            scanner: {
              scan: (target, ref, waitMillis) =>
                Effect.flatMap(consumerOf(target, scannerName(ref), "run"), (stub) =>
                  callOnce(stub.bfScannerScan(target, ref, waitMillis)),
                ),
              ready: (target, ref, waitMillis) =>
                Effect.flatMap(consumerOf(target, scannerName(ref), "run"), (stub) =>
                  callOnce(stub.bfScannerReady(target, waitMillis)),
                ),
              kick: (target, ref) =>
                Effect.flatMap(consumerOf(target, scannerName(ref), "run"), (stub) =>
                  callOnce(stub.bfScannerKick(target, ref)),
                ),
            },
            relay: {
              run: (name, run, items) =>
                Effect.flatMap(consumerOf(run.target, relayName(run.target, name), "run"), (stub) =>
                  callOnce<Backfill.RelayResult>(stub.bfRelayRun(name, run, items)),
                ),
            },
            run: {
              begin: (target, plan) =>
                Effect.flatMap(consumerOf(target, RUN_ROOT, "run"), (stub) =>
                  callOnce<Backfill.Begin>(stub.bfRunBegin(target, plan)),
                ),
              phase: (target) =>
                complete.has(target)
                  ? Effect.succeed("complete" as const)
                  : Effect.flatMap(consumerOf(target, RUN_ROOT, "run"), (stub) =>
                      callOnce<Backfill.Phase>(stub.bfRunPhase(target)),
                    ).pipe(
                      Effect.tap((phase) =>
                        Effect.sync(() => {
                          if (phase === "complete") complete.add(target);
                        }),
                      ),
                    ),
              progress: (target) =>
                Effect.flatMap(consumerOf(target, RUN_ROOT, "run"), (stub) =>
                  callOnce<Backfill.Progress>(stub.bfRunProgress(target)),
                ),
            },
          };
          directory = yield* inInit(object("DomainDirectory", directoryObject(net, random)));

          // A deploy's backfill: the host starts each new consumer's run and waits.
          const deployBackfill =
            host.backfill === undefined
              ? undefined
              : yield* inInit(
                  host.backfill(hosted, (targets: ReadonlyArray<string>) =>
                    plansOf(targets, planOf),
                  ),
                );

          // The first Domain call in each isolate starts the runs of the model's
          // consumers (each starts once): where no deploy-time job runs them, that
          // starts a catch-up. The call doesn't wait for it: the runs start in the
          // background, kept alive by the invocation, and a later call starts them
          // again if they didn't all start.
          let news: Effect.Effect<void> | undefined;
          // Begin the pending runs; on failure they stay pending, for the next try.
          const beginPending: Effect.Effect<void, unknown> = Effect.suspend(() => {
            const pending = news;
            if (pending === undefined) return Effect.void;
            news = undefined;
            return pending.pipe(
              Effect.timeout("5 seconds"),
              Effect.catchCause((cause) =>
                Effect.andThen(
                  Effect.sync(() => {
                    news ??= pending;
                  }),
                  Effect.fail(cause),
                ),
              ),
            );
          });
          const announce = Effect.uninterruptible(
            Effect.suspend(() => {
              if (news === undefined) return Effect.void;
              const begin = Effect.ignoreCause(beginPending);
              if (host.background === undefined)
                return begin.pipe(Effect.forkDetach, Effect.asVoid);
              return host
                .background(begin)
                .pipe(Effect.flatMap((handed) => (handed ? Effect.void : begin)));
            }),
          );

          const modelHost: ModelHost = {
            aggregate: (aggregate, kit) =>
              inInit(
                Effect.gen(function* () {
                  const name = `${aggregate.aggregateName}Aggregate`;
                  const namespace = yield* object(
                    name,
                    aggregateObject(
                      kit,
                      net,
                      current,
                      consumerPlans,
                      random,
                      (address) =>
                        (
                          sources.get(`${address.aggregate}Aggregate`) ??
                          bound(`${address.aggregate}Aggregate`)
                        )?.getByName(address.id),
                      (name) => decisions.get(name),
                    ),
                  );
                  sources.set(name, namespace);
                  return {
                    send: (id, command, meta) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<SendResult>(
                            namespace.getByName(id).send(id, command, meta),
                          ),
                        ),
                      ),
                    schedule: (id, name, command, meta, due) =>
                      unwrapDefects<{ readonly at: number }>(
                        namespace.getByName(id).schedule(id, name, command, meta, due),
                      ).pipe(Effect.map((outcome) => outcome.at)),
                    // The object answers with a tag (RPC loses typed failures); fail with it here.
                    unschedule: (id, commandId) =>
                      unwrapDefects<
                        "Cancelled" | "AlreadyCancelled" | "AlreadyExecuted" | "NotScheduled"
                      >(namespace.getByName(id).unschedule(commandId)).pipe(
                        Effect.flatMap(
                          (
                            outcome,
                          ): Effect.Effect<
                            void,
                            AlreadyExecuted | AlreadyCancelled | NotScheduled
                          > => {
                            const fields = { aggregate: aggregate.aggregateName, id, commandId };
                            if (outcome === "AlreadyExecuted")
                              return Effect.fail(new AlreadyExecuted(fields));
                            if (outcome === "AlreadyCancelled")
                              return Effect.fail(new AlreadyCancelled(fields));
                            if (outcome === "NotScheduled")
                              return Effect.fail(new NotScheduled(fields));
                            return Effect.void;
                          },
                        ),
                      ),
                    import: (id, events, meta) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<ImportResult>(
                            namespace.getByName(id).importEvents(id, events, meta),
                          ),
                        ),
                      ),
                    state: (id) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<{ state: Json; version: number }>(
                            namespace.getByName(id).state(),
                          ),
                        ),
                      ),
                    events: (id) =>
                      unwrapDefects<ReadonlyArray<StoredEvent>>(namespace.getByName(id).after(0)),
                    rewrite: (id, input) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<RewriteResult>(namespace.getByName(id).rewrite(id, input)),
                        ),
                      ),
                    rewriteStatus: (id, rewriteId) =>
                      unwrapDefects<RewriteStatus | null>(
                        namespace.getByName(id).rewriteStatus(rewriteId),
                      ).pipe(Effect.map((status) => status ?? undefined)),
                    compact: (id, name) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<CompactResult>(namespace.getByName(id).compact(id, name)),
                        ),
                      ),
                    changes: (id) =>
                      Stream.fromEffectSchedule(
                        unwrapDefects<{ state: Json; version: number }>(
                          namespace.getByName(id).state(),
                        ),
                        POLL,
                      ).pipe(Stream.changesWith((a, b) => a.version === b.version)),
                    tail: (id, from) =>
                      pollAfter(
                        from,
                        (cursor) =>
                          unwrapDefects<ReadonlyArray<StoredEvent>>(
                            namespace.getByName(id).after(cursor),
                          ),
                        (event) => event.envelope.seq,
                      ),
                  };
                }),
              ),
            // A decision has no object of its own: the first instance it reads
            // decides it and drives the commit. See `TwoPhase`.
            decision: (decision, kit) =>
              Effect.sync(() => {
                decisions.set(decision.decisionName, kit);
                return {
                  send: (command, meta) =>
                    announce.pipe(
                      Effect.andThen(
                        commitDecision({
                          kit,
                          command,
                          meta,
                          primary: (read) => {
                            const namespace =
                              sources.get(`${read.aggregate}Aggregate`) ??
                              bound(`${read.aggregate}Aggregate`);
                            return namespace === undefined
                              ? Effect.die(
                                  new DefinitionError({
                                    reason: new DecisionsUnsupported({
                                      decisions: [decision.decisionName],
                                    }),
                                  }),
                                )
                              : unwrapDefects<DecisionResult>(
                                  namespace
                                    .getByName(read.id)
                                    .txDecide(read.id, decision.decisionName, command, meta),
                                );
                          },
                        }),
                      ),
                    ),
                };
              }),
            view: (view, kit) =>
              inInit(
                Effect.gen(function* () {
                  // A view rebuilt in place keeps its class: see `Kernel.inPlace`.
                  const cls = consumerClass("view", view.viewName, kit.classGeneration);
                  const namespace = yield* object(
                    cls,
                    viewObject(kit, net, current, consumerPlans, random),
                  );
                  sources.set(cls, namespace);
                  viewGenerations.set(view.viewName, kit.classGeneration);
                  consumers.set(cls, namespace);
                  consumers.set(
                    runClass(cls),
                    yield* object(
                      runClass(cls),
                      viewObject(kit, net, current, consumerPlans, random),
                    ),
                  );
                  const target = kit.target;
                  // A lazy view's key reads its history from its one source the first
                  // time it is read; each isolate asks a key once.
                  const caughtUp = new Set<string>();
                  const ready = (key: string): Effect.Effect<void> =>
                    Effect.suspend(() => {
                      const catchUp = kit.catchUp;
                      if (catchUp === undefined || caughtUp.has(key)) return Effect.void;
                      return net.consumer
                        .start(target, key, { source: catchUp.source, id: key }, 20_000)
                        .pipe(
                          Effect.repeat({ until: (started) => started === "settled", times: 5 }),
                          Effect.tap((started) =>
                            Effect.sync(() => {
                              if (started === "settled") caughtUp.add(key);
                            }),
                          ),
                          Effect.asVoid,
                        );
                    });
                  /**
                   * The key computed here, with this code, from its source's events.
                   * A key's object still on the code from before a deploy (until it is
                   * idle) can't fill itself for a version it doesn't know: until it
                   * moves, its reads are answered this way, and nothing is stored.
                   */
                  const computed = (key: string) =>
                    Effect.gen(function* () {
                      const source = kit.catchUp!.source;
                      const deliveries: Array<Delivery> = [];
                      for (let after = 0; ;) {
                        const rows = yield* net.source.log({ source, id: key }, after, 1_000);
                        for (const row of yield* kit.history(target, source, key, rows))
                          deliveries.push(...row.deliveries);
                        if (rows.length < 1_000) break;
                        after += rows.length;
                      }
                      return yield* kit.apply(key, emptySnapshot, deliveries);
                    });
                  /** Read from the key's object, or compute it here while that object can't fill itself. */
                  const orComputed = <A>(
                    fromObject: Effect.Effect<A>,
                    fromHere: (result: Effect.Success<ReturnType<typeof computed>>) => A,
                    key: string,
                  ): Effect.Effect<A> =>
                    ready(key).pipe(
                      Effect.andThen(fromObject),
                      Effect.catchCause((cause) =>
                        kit.catchUp === undefined
                          ? Effect.failCause(cause)
                          : Effect.map(computed(key), fromHere),
                      ),
                    );
                  const read = (key: string) =>
                    announce.pipe(
                      Effect.andThen(
                        orComputed(
                          unwrapDefects<ViewSnapshot>(namespace.getByName(key).read()),
                          (result) => result.snapshot,
                          key,
                        ),
                      ),
                    );
                  const after = (key: string, cursor: number) =>
                    orComputed(
                      unwrapDefects<ReadonlyArray<ViewEntry>>(
                        namespace.getByName(key).after(cursor),
                      ),
                      (result) => result.entries.filter((entry) => entry.seq > cursor),
                      key,
                    );
                  const connect = host.connect;
                  return {
                    receive: (key, deliveries) =>
                      unwrapDefects(namespace.getByName(key).receive(key, deliveries)),
                    revised: (key, root, source) =>
                      unwrapDefects<ReadonlyArray<Revised> | null>(
                        namespace.getByName(key).revised(root, source),
                      ).pipe(Effect.map((sent) => sent ?? undefined)),
                    read,
                    // Streamed responses poll; WebSocket reads (`connect`) are pushed on commit.
                    changes: (key) =>
                      Stream.fromEffectSchedule(read(key), POLL).pipe(
                        Stream.changesWith((a, b) => a.version === b.version),
                      ),
                    list: (key, range) =>
                      orComputed(
                        unwrapDefects<ReadonlyArray<ViewEntry>>(
                          namespace.getByName(key).page(range),
                        ),
                        (result) => inRange(result.entries, range),
                        key,
                      ),
                    ...(connect === undefined
                      ? {}
                      : {
                          connect: (key: string, subscription: Subscription) =>
                            ready(key).pipe(Effect.andThen(connect(namespace, key, subscription))),
                        }),
                    tail: (key, from) =>
                      pollAfter(
                        from,
                        (cursor) => after(key, cursor),
                        (entry) => entry.seq,
                      ),
                  };
                }),
              ),
            projection: (projection, kit) =>
              inInit(
                Effect.gen(function* () {
                  const cls = consumerClass(
                    "projection",
                    projection.projectionName,
                    kit.generation,
                  );
                  const namespace = yield* object(
                    cls,
                    projectionObject(kit, net, consumerPlans, random),
                  );
                  consumers.set(cls, namespace);
                  consumers.set(
                    runClass(cls),
                    yield* object(runClass(cls), projectionObject(kit, net, consumerPlans, random)),
                  );
                  return {
                    receive: (delivery) =>
                      unwrapDefects(
                        namespace.getByName(delivery.key).receive(delivery.key, delivery),
                      ),
                    checkpoints: (key, sources) =>
                      unwrapDefects<Readonly<Record<string, number>>>(
                        namespace.getByName(key).checkpoints(sources),
                      ),
                    revised: (key, root, source) =>
                      unwrapDefects<boolean>(namespace.getByName(key).revised(root, source)),
                  };
                }),
              ),
            stream: (stream, kit) =>
              inInit(
                Effect.gen(function* () {
                  const namespace = yield* object(`${stream.streamName}Stream`, streamObject(kit));
                  const read = (key: string) =>
                    unwrapDefects<StreamMeta>(namespace.getByName(key).read());
                  const after = (key: string, cursor: number) =>
                    unwrapDefects<ReadonlyArray<StreamEntry>>(
                      namespace.getByName(key).after(cursor),
                    );
                  const connect = host.connect;
                  return {
                    append: (key, write) =>
                      unwrapDefects(namespace.getByName(key).append(key, write)),
                    advance: (key, handled) =>
                      unwrapDefects(namespace.getByName(key).advance(handled)),
                    revise: (key, revision) =>
                      unwrapDefects(namespace.getByName(key).revise(key, revision)),
                    read,
                    // Streamed responses poll; WebSocket reads (`connect`) are pushed on append.
                    changes: (key) =>
                      Stream.fromEffectSchedule(read(key), POLL).pipe(
                        Stream.changesWith((a, b) => a.seq === b.seq),
                      ),
                    list: (key, range) =>
                      unwrapDefects<ReadonlyArray<StreamEntry>>(
                        namespace.getByName(key).page(range),
                      ),
                    tail: (key, from) =>
                      pollAfter(
                        from,
                        (cursor) => after(key, cursor),
                        (e) => e.seq,
                      ),
                    ...(connect === undefined ? {} : { connect: connect.bind(null, namespace) }),
                  };
                }),
              ),
            history: (target) =>
              net.run
                .phase(target)
                .pipe(Effect.map((phase) => ({ complete: phase === "complete" }))),
            start: (targets, plansOfTarget, backfilled) =>
              Effect.gen(function* () {
                // At deploy time: the host runs the backfill of new consumers and waits.
                if (
                  !globalThis.__ALCHEMY_RUNTIME__ &&
                  backfilled.length > 0 &&
                  deployBackfill !== undefined
                ) {
                  planOf = plansOfTarget;
                  yield* inInit(deployBackfill(backfilled));
                }
              }).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    model = targets;
                    planOf = plansOfTarget;
                    if (backfilled.length === 0) return Effect.void;
                    // Where no deploy-time job runs, the first call starts each run (once).
                    // Each run's root is an object of its own: start them all at once.
                    news = Effect.suspend(() => {
                      const plans = plansOf(backfilled, planOf);
                      return Effect.forEach(
                        backfilled.filter((target) => plans[target] !== undefined),
                        (target) => net.run.begin(target, plans[target]!),
                        { discard: true, concurrency: "unbounded" },
                      );
                    });
                    // A host that can reach the runs on its own begins them now.
                    return host.begin === undefined
                      ? Effect.void
                      : inInit(host.begin(beginPending));
                  }),
                ),
              ),
            policy: (policy, kit) =>
              inInit(
                Effect.gen(function* () {
                  const namespace = yield* object(`${policy.policyName}Policy`, policyObject(kit));
                  return {
                    receive: (delivery) =>
                      unwrapDefects(namespace.getByName(delivery.key).receive(delivery)),
                  };
                }),
              ),
          };
          return modelHost;
        });

      return Platform.of({
        keys: Effect.map(
          inInit(host.declare(VAULT, "VaultKeys", bindState(keyObject))),
          (namespace): KeyStore["Service"] => ({
            get: (subject) =>
              Effect.map(
                unwrapDefects<string | null>(namespace.getByName(subject).keyGet()),
                Option.fromNullishOr,
              ),
            create: (subject, key) =>
              unwrapDefects<string>(namespace.getByName(subject).keyCreate(key)),
            delete: (subject) => unwrapDefects<void>(namespace.getByName(subject).keyDelete()),
          }),
        ),
        model: (model) =>
          Effect.gen(function* () {
            yield* claim(model.modelName, model.id);
            if (host.hosted !== undefined) yield* inInit(host.hosted(model));
            const hosted = hosts.get(model.modelName);
            if (hosted !== undefined) return hosted;
            const built = yield* hostFor(model);
            hosts.set(model.modelName, built);
            return built;
          }),
      });
    }),
  );

// ---------------------------------------------------------------- shared host pieces

/**
 * An object's name inside a host that keeps every class of a model in one
 * class of its own (Rivet, Effect Cluster): `Bank.AccountAggregate/a-1`.
 */
export const multiplexedName = (model: string, name: string, key: string) =>
  `${className(model, name)}/${key}`;

/** A model's class name: `Billing.AccountAggregate`. */
export const className = (modelName: string, name: string) =>
  `${modelName}.${name}`.replace(/[^A-Za-z0-9_.]/g, "_");

/** Split a {@link multiplexedName} back into its class and key. */
export const parseMultiplexedName = (name: string) => {
  const slash = name.indexOf("/");
  return slash < 0 ? undefined : { className: name.slice(0, slash), key: name.slice(slash + 1) };
};
