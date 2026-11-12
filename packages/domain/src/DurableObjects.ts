import {
  type Callback,
  type CallbackFactory,
  type CallbackOptions,
  type CallbackStatus,
  makeCallback,
} from "alchemy/Callback";
/**
 * A domain model on Durable Objects, for any runtime that hosts them:
 * Cloudflare, Rivet, Effect Cluster. Every aggregate instance, view key,
 * policy, projection key and stream key is one object, and this module is
 * everything those objects do. A platform supplies a {@link Host}: how to
 * declare a class of objects and call one by name, and, per instance, an
 * {@link ObjectState} (storage, an exclusive section, background work) and a
 * `RuntimeContext` that can `makeCallback`.
 *
 * @module
 */
import type { HttpEffect } from "alchemy/Http";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { isAfter, mergeCheckpoints } from "./InMemory.ts";
import {
  type Accepted,
  type AggregateKit,
  captureContext,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  type HostedModel,
  hostedModels,
  inRange,
  type Json,
  type ListRange,
  type ModelHost,
  Platform,
  type PolicyKit,
  type ProjectionKit,
  type Push,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamKit,
  type StreamMeta,
  type StreamWrite,
  Subscription,
  type ViewEntry,
  type ViewKit,
  type ViewSnapshot,
} from "./Platform.ts";

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
export type InstanceServices = ObjectState | RuntimeContext | Scope.Scope;

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
  /** Models whose names collide on the same key fail to host: one per Worker, pool or class. */
  readonly claimKey: Effect.Effect<object, never, R>;
}

const pad = (n: number) => n.toString().padStart(12, "0");

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
 * A durable, ordered work queue in the instance's storage. Rows are written
 * in the same transaction as the state change that produced them, processed
 * right after the commit (`kick`), and again by a durable callback if the
 * instance dies first. One drain runs at a time (a storage lease), rows are
 * processed in order, and a row is deleted only after its work succeeds.
 */
const queue = <Row>(name: string, process: (row: Row) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const prefix = `${name}:`;
    const lease = `${name}-lease`;
    const acquire = exclusively(
      Effect.gen(function* () {
        const held = yield* state.storage.get<number>(lease);
        if (held !== undefined && held > (yield* Clock.currentTimeMillis)) return false;
        yield* state.storage.put(lease, (yield* Clock.currentTimeMillis) + LEASE_MS);
        return true;
      }),
    );
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Durable Object provides its state and RuntimeContext on every event
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      if (!(yield* acquire)) return;
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
          const entries: Record<string, Row> = {};
          rows.forEach((row, index) => {
            entries[`${prefix}${pad(last - rows.length + index + 1)}`] = row;
          });
          yield* state.storage.put(entries);
          yield* state.storage.put(`${name}-seq`, last);
          // The backstop: delivered even if this instance dies before `kick` runs.
          // Its rows are progress, so a callback staging them doesn't hand it
          // its retry budget.
          yield* callback.schedule("drain", { after: "10 seconds", payload: {}, progress: last });
        }),
      /** Process staged rows now, in the background, keeping the instance alive until done. */
      kick: state.waitUntil(drain.pipe(Effect.ignoreCause)),
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

/** Push to every live read of this instance after a commit. Runs inside the commit's exclusive section. */
const broadcast = (
  push: (attachment: Attachment) => Effect.Effect<Push, never, ObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    if (state.sockets === undefined) return;
    for (const socket of yield* state.sockets.all()) {
      const attachment = socket.deserializeAttachment<Attachment>();
      if (attachment === null) continue;
      yield* deliverPush(socket, attachment.key, push(attachment));
    }
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
    const context = yield* captureContext<ObjectState | RuntimeContext>();
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

/**
 * List an instance in the directory before its first commit, so every
 * instance with an event can be reached when a consumer is added later.
 */
const ensureRegistered = (net: Backfill.Network, ref: Backfill.SourceRef) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    if (yield* state.storage.get<boolean>("registered")) return;
    yield* net.node.register(Backfill.leafOf(ref), ref);
    yield* state.storage.put({ registered: true, [ID_KEY]: ref.id });
  });

const aggregateObject = (
  kit: AggregateKit,
  net: Backfill.Network,
  model: () => ReadonlyArray<string>,
  planOf: PlanOf,
  random: Random,
) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const outbox = yield* queue<Delivery>("outbox", kit.deliver);
    const currentMeta = state.storage
      .get<{ state: Json; version: number }>("meta")
      .pipe(Effect.map((meta) => meta ?? { state: null, version: 0 }));
    const eventsAfter = (after: number) =>
      state.storage
        .list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}` })
        .pipe(Effect.map((rows) => [...rows.values()]));

    // This instance as a backfill source: consumers added later pull its events.
    let source: Backfill.Source | undefined;
    const runtime = yield* backfillRuntime(random, (id) =>
      id === "bf-flush"
        ? Effect.flatMap(state.storage.get<string>(ID_KEY), (stored) =>
            stored === undefined ? Effect.void : sourceFor(stored).flush,
          )
        : Effect.void,
    );
    const sourceFor = (id: string): Backfill.Source =>
      (source ??= Backfill.makeSource(runtime.storage, runtime.jobs, net, {
        ref: { source: kit.name, id },
        singleSource: (target) => planOf(target)?.singleSource === true,
        model,
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
        const duplicate = yield* state.storage.get<SendResult>(`receipt:${meta.commandId}`);
        if (duplicate) return { sent: duplicate, kick: false };
        const current = yield* currentMeta;
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
        const routed = yield* state.storage.transaction(
          Effect.gen(function* () {
            const events: Record<string, StoredEvent> = {};
            for (const event of result.events) events[`event:${pad(event.envelope.seq)}`] = event;
            yield* state.storage.put(events);
            yield* state.storage.put("meta", {
              state: result.state,
              version: result.version,
            });
            yield* state.storage.put(`receipt:${meta.commandId}`, sent);
            // Live to caught-up consumers; through the backfill to lagging ones.
            const live = yield* Backfill.routeCommit(
              sourceFor(id),
              kit.targets,
              yield* state.storage.get<Routed>("routed"),
              current.version,
              result.version,
              result.deliveries,
            );
            yield* state.storage.put("routed", live.routed);
            yield* outbox.stage(live.send);
            return live.send;
          }),
        );
        return { sent, kick: routed.length > 0 };
      });
    const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
      Effect.gen(function* () {
        yield* ensureRegistered(net, { source: kit.name, id });
        const { sent, kick } = yield* exclusively(commit(id, command, meta));
        if (kick) yield* outbox.kick;
        return sent;
      });
    const executed = (commandId: string) =>
      state.storage
        .get<SendResult>(`receipt:${commandId}`)
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
          yield* ensureRegistered(net, { source: kit.name, id: job.id });
          const kick = yield* exclusively(
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
        }),
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
      state: () => reportDefects(currentMeta),
      after: (after: number) => reportDefects(eventsAfter(after)),
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
    const outbox = yield* queue<Delivery>("outbox", kit.deliver);
    const stored = state.storage
      .get<ViewSnapshot>("snapshot")
      .pipe(Effect.map((s) => s ?? emptySnapshot));
    // Built by an earlier generation of the view: it reads as empty, and starts over on write.
    const stale = (snapshot: ViewSnapshot) => (snapshot.generation ?? 0) < kit.generation;
    const read = stored.pipe(Effect.map((s) => (stale(s) ? emptySnapshot : s)));
    const reset = Effect.gen(function* () {
      if (!stale(yield* stored)) return;
      yield* clearPrefixes(["entry:", "in:"]);
      yield* state.storage.delete(["snapshot", "routed", "in-seq"]);
    });
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
    const apply = (key: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        yield* reset;
        const before = yield* read;
        const result = yield* kit.apply(key, before, deliveries);
        if (!result.changed) return;
        const rows: Record<string, ViewEntry> = {};
        for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
        // The key's immutable input log: every delivery it applied, in order.
        const accepted = deliveries.filter((d) => (before.checkpoints[d.source] ?? 0) < d.seq);
        const inputs = (yield* state.storage.get<number>("in-seq")) ?? 0;
        const log: Record<string, Delivery> = {};
        accepted.forEach((delivery, index) => {
          log[`in:${pad(inputs + index + 1)}`] = delivery;
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
      }).pipe(kit.observe(key, deliveries));
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
          if (id.startsWith("bf-merge:"))
            // Listed before its first entry, as on the live path, but here in the key's
            // own job: its sources' messages don't wait on the directory.
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
      receive: (key: string, deliveries: ReadonlyArray<Delivery>) =>
        reportDefects(
          Effect.gen(function* () {
            yield* ensureRegistered(net, { source: kit.name, id: key });
            // While a backfill runs, the key buffers deliveries and merges them in order.
            if (!(yield* consumerFor(key).admit(target, deliveries))) return;
            yield* exclusively(state.storage.transaction(apply(key, deliveries)));
            yield* flushAfter;
          }),
        ),
      read: () => reportDefects(read),
      after: (after: number) => reportDefects(entriesAfter(after)),
      page: (range: ListRange | undefined) => reportDefects(entriesIn(range)),
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
      fetch: accept((key, subscription) =>
        Effect.gen(function* () {
          const snapshot = yield* read;
          const entries =
            subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
          return yield* kit.push(key, subscription, snapshot, entries);
        }),
      ),
      ...socketHandlers,
    };
  });

const policyObject = (kit: PolicyKit) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const inbox = yield* queue<Delivery>("inbox", kit.run);
    return {
      receive: (delivery: Delivery) =>
        reportDefects(
          Effect.gen(function* () {
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

/** The stored progress of one projection key. */
interface ProjectionMeta {
  readonly key: string | null;
  /** Inputs accepted into the log. */
  readonly accepted: number;
  /** Inputs handled. */
  readonly processed: number;
  /** The last accepted `seq` per source: duplicates are dropped on arrival. */
  readonly intake: Readonly<Record<string, number>>;
  /** The last handled `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** The projection's generation the log was built by: an earlier one starts over. */
  readonly generation?: number;
}

const emptyProjectionMeta: ProjectionMeta = {
  key: null,
  accepted: 0,
  processed: 0,
  intake: {},
  checkpoints: {},
};

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
      yield* clearPrefixes(["in:"]);
      yield* state.storage.delete("meta");
    });
    const size = kit.options.batch?.size ?? 1;
    const waitMillis = kit.options.batch?.waitMillis ?? 0;
    const lease = "drain-lease";
    const acquire = exclusively(
      Effect.gen(function* () {
        const held = yield* state.storage.get<number>(lease);
        if (held !== undefined && held > (yield* Clock.currentTimeMillis)) return false;
        yield* state.storage.put(lease, (yield* Clock.currentTimeMillis) + LEASE_MS);
        return true;
      }),
    );
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
      if (!(yield* acquire)) return;
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
              Effect.gen(function* () {
                const current = yield* readMeta;
                const handled: Record<string, number> = {};
                for (const { delivery } of run) {
                  handled[delivery.source] = Math.max(handled[delivery.source] ?? 0, delivery.seq);
                }
                yield* state.storage.put("meta", {
                  ...current,
                  processed: run[run.length - 1]!.position,
                  checkpoints: mergeCheckpoints(current.checkpoints, handled),
                } satisfies ProjectionMeta);
              }),
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
    const intake = (key: string, delivery: Delivery) =>
      Effect.gen(function* () {
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
        const meta = yield* readMeta;
        if ((meta.intake[delivery.source] ?? 0) >= delivery.seq) return false;
        const position = meta.accepted + 1;
        yield* state.storage.put(`in:${pad(position)}`, {
          position,
          delivery,
          at: yield* Clock.currentTimeMillis,
        } satisfies Accepted);
        yield* state.storage.put("meta", {
          ...meta,
          key,
          accepted: position,
          intake: { ...meta.intake, [delivery.source]: delivery.seq },
        } satisfies ProjectionMeta);
        // The backstop: handled even if this instance dies before the drain runs.
        yield* callback.schedule("drain", {
          after: `${Math.max(waitMillis, PROJECTION_RETRY_MS)} millis`,
          payload: {},
          progress: yield* advance,
        });
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
            if (!(yield* consumerFor(key).admit(target, [delivery]))) return;
            const accepted = yield* exclusively(state.storage.transaction(intake(key, delivery)));
            if (accepted) yield* state.waitUntil(drain.pipe(Effect.ignoreCause));
          }),
        ),
      checkpoints: () => reportDefects(readMeta.pipe(Effect.map((meta) => meta.checkpoints))),
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

const streamObject = (kit: StreamKit) =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
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
          const meta = yield* readMeta;
          if (!isAfter(write.origin, meta.origin)) return;
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
            };
          });
          const next: StreamMeta = {
            seq: meta.seq + added.length,
            origin: write.origin,
            checkpoints: mergeCheckpoints(meta.checkpoints, {
              [write.source]: write.sourceSeq,
            }),
          };
          yield* state.storage.transaction(
            Effect.gen(function* () {
              const rows: Record<string, StreamEntry> = {};
              for (const entry of added) rows[`entry:${pad(entry.seq)}`] = entry;
              if (added.length > 0) yield* state.storage.put(rows);
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
      advance: (checkpoints: Readonly<Record<string, number>>) =>
        Effect.gen(function* () {
          const meta = yield* readMeta;
          yield* state.storage.put("meta", {
            ...meta,
            checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
          } satisfies StreamMeta);
        }).pipe(exclusively, reportDefects),
      read: () => reportDefects(readMeta),
      after: (after: number) => reportDefects(entriesAfter(after)),
      page: (range: ListRange | undefined) => reportDefects(entriesIn(range)),
      // A live read of this key: accept its WebSocket, then push on every append.
      fetch: accept((key, subscription) =>
        Effect.gen(function* () {
          const meta = yield* readMeta;
          const entries =
            subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
          return yield* kit.push(key, subscription, meta, entries, yield* latest(meta));
        }),
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
          // starts a catch-up.
          let news: Effect.Effect<void> | undefined;
          const announce = Effect.suspend(() => {
            const pending = news;
            if (pending === undefined) return Effect.void;
            news = undefined;
            return pending.pipe(
              Effect.timeout("5 seconds"),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  news = pending;
                }),
              ),
            );
          });

          const modelHost: ModelHost = {
            aggregate: (aggregate, kit) =>
              inInit(
                Effect.gen(function* () {
                  const name = `${aggregate.aggregateName}Aggregate`;
                  const namespace = yield* object(
                    name,
                    aggregateObject(kit, net, current, consumerPlans, random),
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
                    state: (id) =>
                      announce.pipe(
                        Effect.andThen(
                          unwrapDefects<{ state: Json; version: number }>(
                            namespace.getByName(id).state(),
                          ),
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
                    checkpoints: (key) =>
                      unwrapDefects<Readonly<Record<string, number>>>(
                        namespace.getByName(key).checkpoints(),
                      ),
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
                    advance: (key, checkpoints) =>
                      unwrapDefects(namespace.getByName(key).advance(checkpoints)),
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
                  Effect.sync(() => {
                    model = targets;
                    planOf = plansOfTarget;
                    if (backfilled.length === 0) return;
                    // Where no deploy-time job runs, the first call starts each run (once).
                    news = Effect.suspend(() => {
                      const plans = plansOf(backfilled, planOf);
                      return Effect.forEach(
                        backfilled.filter((target) => plans[target] !== undefined),
                        (target) => net.run.begin(target, plans[target]!),
                        { discard: true },
                      );
                    });
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

// ---------------------------------------------------------------- callbacks over one alarm

/** One alarm per instance, as Durable Objects have: setting it replaces it. */
export interface Alarm {
  readonly set: (at: number) => Effect.Effect<void>;
  readonly get: Effect.Effect<number | null>;
}

/** A pending callback job, stored under {@link jobKey}. */
interface CallbackJob {
  /** When it was asked for, kept across retries. */
  readonly scheduledAt: number;
  /** When it runs next: `scheduledAt`, or a retry's time. */
  readonly due: number;
  readonly payload: unknown;
  /** Attempts that failed since it was scheduled. */
  readonly attempts: number;
  /** Replaced by every schedule: a job scheduled again while it ran isn't removed. */
  readonly token: string;
  readonly progress?: number;
}

const JOB_PREFIX = "cb:";
const jobKey = (name: string, id: string) => `${JOB_PREFIX}${encodeURIComponent(name)}:${id}`;
const jobName = (key: string) =>
  decodeURIComponent(key.slice(JOB_PREFIX.length, key.indexOf(":", JOB_PREFIX.length)));

const HOUR = 60 * 60 * 1000;

/**
 * Durable callbacks (`alchemy/Callback`) over an instance's storage and its
 * one alarm, for hosts that don't implement `RuntimeContext.makeCallback`
 * (Rivet, Effect Cluster). Jobs are rows in the instance's storage; the alarm
 * is set for the soonest, and `fire` (the instance's alarm handler) runs the
 * due ones. A job that fails is retried with backoff, from `retry.delay`
 * (30 seconds) doubling, and after `retry.maxAttempts` (8) is retried every
 * `retry.parkedDelay` (an hour). Delivery is at least once.
 *
 * Handlers run in Node processes here, not workerd, so `fire` keeps an
 * in-memory flag to run one pass at a time.
 */
export const alarmCallbacks = (storage: ObjectStorage, alarm: Alarm) => {
  const handlers = new Map<
    string,
    {
      readonly run: (payload: unknown) => Effect.Effect<unknown, unknown>;
      readonly options: CallbackOptions | undefined;
    }
  >();
  const arm = (due: number) =>
    Effect.gen(function* () {
      const current = yield* alarm.get;
      if (current === null || due < current) yield* alarm.set(due);
    });
  const token = Effect.map(
    Effect.all([Clock.currentTimeMillis, Random.nextInt]),
    ([now, n]) => `${now.toString(36)}-${(n >>> 0).toString(36)}`,
  );

  const makeCallback: CallbackFactory = (name, handler, options) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      handlers.set(name, {
        // Each invocation gets a fresh Scope.
        run: (payload) =>
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the handler's services are the ones it was registered with
          Effect.scoped(handler(payload as never)).pipe(Effect.provide(context)) as Effect.Effect<
            unknown,
            unknown
          >,
        options,
      });
      const callback: Callback<any> = {
        schedule: (id, scheduled) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const due =
              scheduled.at !== undefined
                ? typeof scheduled.at === "number"
                  ? scheduled.at
                  : scheduled.at.getTime()
                : now + Duration.toMillis(Duration.fromInputUnsafe(scheduled.after));
            const key = jobKey(name, id);
            const existing = yield* storage.get<CallbackJob>(key);
            // A replayed schedule can't replace newer work.
            if (
              scheduled.progress !== undefined &&
              existing?.progress !== undefined &&
              scheduled.progress < existing.progress
            )
              return;
            yield* storage.put(key, {
              scheduledAt: due,
              due,
              payload: scheduled.payload,
              attempts: 0,
              token: yield* token,
              progress: scheduled.progress ?? existing?.progress,
            } satisfies CallbackJob);
            yield* arm(due);
          }),
        cancel: (id) => Effect.asVoid(storage.delete(jobKey(name, id))),
        getStatus: (id) =>
          storage.get<CallbackJob>(jobKey(name, id)).pipe(
            Effect.map((job): CallbackStatus | undefined => {
              if (job === undefined) return undefined;
              const max = options?.retry?.maxAttempts ?? 8;
              return {
                scheduledAt: job.scheduledAt,
                retryAt: job.attempts > 0 ? job.due : undefined,
                attempts: Math.min(job.attempts, max),
                parked: job.attempts >= max,
                progress: job.progress,
              };
            }),
          ),
      };
      return callback;
    });

  let firing = false;
  let again = false;
  const pass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const jobs = yield* storage.list<CallbackJob>({ prefix: JOB_PREFIX });
    for (const [key, job] of jobs) {
      if (job.due > now) continue;
      const handler = handlers.get(jobName(key));
      // Not registered by this code: keep it for code that registers it.
      if (handler === undefined) continue;
      const exit = yield* Effect.exit(handler.run(job.payload));
      const after = yield* storage.get<CallbackJob>(key);
      // Scheduled again (or cancelled) while it ran: that stands.
      if (after?.token !== job.token) continue;
      if (exit._tag === "Success") {
        yield* storage.delete(key);
        continue;
      }
      const retry = handler.options?.retry;
      const delay = Math.max(
        1_000,
        Duration.toMillis(Duration.fromInputUnsafe(retry?.delay ?? "30 seconds")),
      );
      const parked = Math.max(
        HOUR,
        delay,
        Duration.toMillis(Duration.fromInputUnsafe(retry?.parkedDelay ?? 0)),
      );
      const attempts = job.attempts + 1;
      const wait =
        attempts >= (retry?.maxAttempts ?? 8)
          ? parked
          : Math.min(parked, delay * 2 ** (attempts - 1));
      yield* Effect.logError(`Callback ${jobName(key)} failed; retrying`, exit.cause);
      yield* storage.put(key, { ...job, attempts, due: (yield* Clock.currentTimeMillis) + wait });
    }
    // Arm the alarm for the soonest job left.
    let next = Infinity;
    for (const job of (yield* storage.list<CallbackJob>({ prefix: JOB_PREFIX })).values())
      next = Math.min(next, job.due);
    if (Number.isFinite(next)) yield* alarm.set(next);
  });
  /** Run every due job, then arm the alarm for the next. The instance's alarm handler. */
  const fire: Effect.Effect<void> = Effect.suspend(() => {
    if (firing) {
      again = true;
      return Effect.void;
    }
    firing = true;
    const loop: Effect.Effect<void> = Effect.suspend(() => {
      again = false;
      return pass.pipe(Effect.andThen(Effect.suspend(() => (again ? loop : Effect.void))));
    });
    return loop.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          firing = false;
        }),
      ),
    );
  });
  return { makeCallback, fire };
};
