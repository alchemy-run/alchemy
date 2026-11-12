/**
 * One entity instance on its durable object (a Cloudflare Durable Object, a
 * Rivet actor), run the way Effect Cluster's runners run one
 * (`effect/cluster`'s entity manager):
 *
 * - The instance's handlers run behind Effect's own `RpcServer`, which
 *   applies the RPCs' middleware, the entity's `concurrency`, `Rpc.fork`
 *   and `Rpc.uninterruptible`.
 * - A persisted message is stored before it runs and its reply after: a
 *   primary key runs once, a duplicate waits for the first run's reply, and
 *   a message cut short by a restart runs again when the object next wakes.
 * - A message with `DeliverAt` waits in storage until its time, which the
 *   object's alarm wakes it for.
 * - An instance holds `mailboxCapacity` messages. A volatile message past
 *   that fails with `MailboxFull`; a persisted one waits in storage and runs
 *   as the instance finishes others, in the order they were stored.
 * - A defect restarts the instance, backing off, and runs its messages
 *   again, unless `disableFatalDefects` returns it to the caller.
 * - The instance stops once idle for `maxIdleTime`, closing its scope,
 *   unless `Entity.keepAlive` holds it; a held instance is started again
 *   after its object restarts.
 *
 * A host evicts an idle object, and the instance's memory with it, so the
 * object's alarm keeps it awake while its instance runs.
 *
 * The host supplies the object's SQLite and alarm as an `EntityStorage`.
 * Its statements may be asynchronous, so every decision about the mailbox
 * runs under one lock: no two events see it half-updated.
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import { ClusterSchema, DeliverAt, Envelope, Snowflake } from "effect/cluster";
import {
  CurrentAddress,
  CurrentRunnerAddress,
  KeepAliveHandler,
  Request as EntityRequest,
} from "effect/cluster/Entity";
import type { EntityAddress } from "effect/cluster/EntityAddress";
import type { RunnerAddress } from "effect/cluster/RunnerAddress";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as PrimaryKey from "effect/PrimaryKey";
import * as Queue from "effect/Queue";
import { type Rpc, RpcMessage, RpcServer } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { HostedEntity } from "../Entity.ts";
import {
  type Call,
  chunkCodec,
  DEFECT,
  decode,
  encode,
  encodeExit,
  type Rejection,
  payloadCodec,
} from "./Wire.ts";

/** How often the alarm wakes the object while its instance runs or is held. */
const KEEP_AWAKE = 5_000;

/** How long a stored message waits before the alarm runs it again, after a restart. */
const REPLAY_AFTER = 30_000;

/** How long a reply without a primary key is kept, for its caller's retries. */
const KEEP_REPLIES = 60 * 60_000;

/** How long an interrupt that arrived before its call waits for it. */
const KEEP_INTERRUPTS = 60_000;

/** Effect Cluster's back-off between attempts to build an instance. */
const restartPolicy = Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced("10 seconds")]);

/** How often the alarm prunes replies older than `KEEP_REPLIES`. */
const PRUNE_EVERY = 10 * 60_000;

/** The object's SQLite and alarm, as its host exposes them. */
export interface EntityStorage {
  /** Run one SQL statement and return its rows. A statement that fails is a defect. */
  readonly exec: <T = never>(
    query: string,
    ...bindings: ReadonlyArray<unknown>
  ) => Effect.Effect<Array<T>>;
  /** Run `effect`'s statements as one transaction. */
  readonly transaction: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>;
  readonly getAlarm: Effect.Effect<number | null>;
  readonly setAlarm: (at: number) => Effect.Effect<void>;
}

export interface EntityRuntimeOptions {
  readonly hosted: HostedEntity;
  readonly address: EntityAddress;
  readonly runnerAddress: RunnerAddress;
  /** What the instance runs with: its Construction phase's services and the cluster's. */
  readonly context: Context.Context<never>;
  readonly storage: EntityStorage;
  /**
   * The most bytes one stored value may take (Cloudflare's SQLite: 2 MB). A
   * persisted call over it is rejected, and a persisted reply or chunk over
   * it fails its message.
   */
  readonly maxEncodedBytes?: number;
  /** Run `effect` in the background, keeping the object alive until it settles. */
  readonly waitUntil: (effect: Effect.Effect<unknown>) => Effect.Effect<void>;
}

/** A message the instance is running, or will run once it is built. */
interface Active {
  /** Its id on the instance's `RpcServer`. */
  readonly id: number;
  /** Its mailbox key: `tag/primaryKey`, or the caller's request id. */
  readonly key: string;
  readonly rpc: Rpc.AnyWithProps;
  readonly request: EntityRequest<Rpc.Any>;
  readonly persisted: boolean;
  /** The callers waiting on it, by their request ids. */
  readonly callers: Set<string>;
  /** Its encoded exit, once it has one. */
  readonly reply: Deferred.Deferred<string>;
  /** Where its stream's chunks go: each caller reading it, given a chunk's encoded values as JSON. */
  readonly listeners: Set<(chunk: string) => Effect.Effect<void>>;
  sequence: number;
  delivered: boolean;
  /** A caller interrupted it: its interrupt is its reply. */
  interrupted: boolean;
}

interface Instance {
  readonly scope: Scope.Closeable;
  readonly server: RpcServer.RpcServer<Rpc.Any>;
}

/** What admitting a call decided. */
type Admission =
  | { readonly _tag: "Run"; readonly active: Active }
  | { readonly _tag: "Wait"; readonly key: string; readonly reply: Deferred.Deferred<string> }
  | { readonly _tag: "Replied"; readonly reply: string; readonly chunks: ReadonlyArray<string> }
  | {
      /** A stream another caller started: the chunks it has sent, then the rest as they come. */
      readonly _tag: "Join";
      readonly active: Active;
      readonly chunks: ReadonlyArray<string>;
    }
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Rejected"; readonly rejection: Rejection };

interface MailboxRow {
  readonly request_id: string;
  readonly call: string;
  readonly exit: string | null;
  readonly deliver_at: number | null;
}

const rejected = (_tag: Rejection["_tag"], message: string): Admission => ({
  _tag: "Rejected",
  rejection: { _tag, message },
});

const accepted: Admission = { _tag: "Accepted" };
const run = (active: Active): Admission => ({ _tag: "Run", active });
const waitOn = (key: string, reply: Deferred.Deferred<string>): Admission => ({
  _tag: "Wait",
  key,
  reply,
});
const replied = (reply: string, chunks: ReadonlyArray<string>): Admission => ({
  _tag: "Replied",
  reply,
  chunks,
});

const replyText = (reply: string) => `{"exit":${reply}}`;

export const makeEntityRuntime = Effect.fn(function* (options: EntityRuntimeOptions) {
  const { hosted, address, storage } = options;
  const entity = hosted.entity;
  const exec = storage.exec;
  const mailbox = yield* Semaphore.make(1);
  /** Run `effect` alone on the mailbox, to its end even if its caller stops waiting. */
  const locked = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(mailbox.withPermits(1), Effect.uninterruptible);

  const limit = options.maxEncodedBytes;
  const encoder = new TextEncoder();
  const tooLarge = (text: string) =>
    limit !== undefined && text.length * 3 > limit && encoder.encode(text).byteLength > limit;

  // One read tells an object that is already laid out; only a new or older
  // one writes its schema.
  const laidOut = new Set(
    (yield* exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('cluster_mailbox_pending', 'cluster_messages')",
    )).map((row) => row.name),
  );
  if (!laidOut.has("cluster_mailbox_pending") || laidOut.has("cluster_messages")) {
    const migratedAt = yield* Clock.currentTimeMillis;
    yield* storage.transaction(
      Effect.gen(function* () {
        yield* exec(
          `CREATE TABLE IF NOT EXISTS cluster_mailbox (
            request_id TEXT PRIMARY KEY,
            call TEXT NOT NULL,
            keyed INTEGER NOT NULL,
            deliver_at INTEGER,
            exit TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
          )`,
        );
        yield* exec(
          "CREATE TABLE IF NOT EXISTS cluster_chunks (request_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (request_id, seq))",
        );
        yield* exec(
          "CREATE TABLE IF NOT EXISTS cluster_entity (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
        );
        if (laidOut.has("cluster_messages")) {
          // The mailbox's first layout: its rows move over, keeping their replies.
          yield* exec(
            `INSERT OR IGNORE INTO cluster_mailbox (request_id, call, keyed, exit, created_at, completed_at)
             SELECT request_id, call, instr(request_id, '/') > 0, exit, ?, CASE WHEN exit IS NULL THEN NULL ELSE ? END
             FROM cluster_messages`,
            migratedAt,
            migratedAt,
          );
          yield* exec("DROP TABLE cluster_messages");
        }
        // Replies with a primary key are kept for good, so what the alarm
        // looks for (messages not yet done, replies to prune) is indexed
        // apart from them.
        yield* exec(
          "CREATE INDEX IF NOT EXISTS cluster_mailbox_completed ON cluster_mailbox (completed_at) WHERE keyed = 0",
        );
        yield* exec(
          "CREATE INDEX IF NOT EXISTS cluster_mailbox_pending ON cluster_mailbox (deliver_at) WHERE exit IS NULL",
        );
      }),
    );
  }

  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const snowflakes = yield* Snowflake.makeGenerator;
  const maxIdle = Duration.toMillis(
    Duration.fromInputUnsafe(hosted.options.maxIdleTime ?? "1 minute"),
  );
  const capacity = hosted.options.mailboxCapacity ?? 4096;

  const actives = new Map<number, Active>();
  const byKey = new Map<string, Active>();
  const byCaller = new Map<string, Active>();
  /** Callers whose interrupt reached the object before their call, and when. */
  const leftEarly = new Map<string, number>();
  /** Callers waiting on a message whose `DeliverAt` hasn't come. */
  const waiters = new Map<string, Array<Deferred.Deferred<string>>>();
  let nextId = 0;
  let instance: Instance | undefined;
  let building: Deferred.Deferred<Instance> | undefined;
  let restarting = false;
  let restarts = 0;
  let replayed = false;
  let lastActive = now();
  let prunedAt = 0;
  /** Stored messages are due and waiting for room on the instance. */
  let backlog = false;
  /** Stored messages without a reply: running, cut short, or waiting for their time or for room. */
  let pending =
    (yield* exec<{ n: number }>("SELECT COUNT(*) AS n FROM cluster_mailbox WHERE exit IS NULL"))[0]
      ?.n ?? 0;
  let keepAlive =
    (yield* exec<{ value: number }>("SELECT value FROM cluster_entity WHERE key = 'keep_alive'"))[0]
      ?.value === 1;
  let armedAt: number | undefined = (yield* storage.getAlarm) ?? undefined;

  // ------------------------------------------------------------ alarm

  /** Wake the object at `at`, unless it already wakes sooner. */
  const arm = (at: number) =>
    Effect.suspend(() => {
      if (armedAt !== undefined && armedAt > now() && armedAt <= at) return Effect.void;
      armedAt = at;
      return storage.setAlarm(at);
    });

  /** The next time the object must wake: for its instance, a replay, or a scheduled message. */
  const rearm = Effect.gen(function* () {
    const at = now();
    let next = Number.POSITIVE_INFINITY;
    if (instance !== undefined || keepAlive) next = at + KEEP_AWAKE;
    if (pending > 0) {
      // A stored message that is due but not done: its run may have been cut short.
      const [due] = yield* exec<{ n: number }>(
        "SELECT EXISTS (SELECT 1 FROM cluster_mailbox WHERE exit IS NULL AND (deliver_at IS NULL OR deliver_at <= ?)) AS n",
        at,
      );
      if ((due?.n ?? 0) > 0) next = Math.min(next, at + REPLAY_AFTER);
      const [scheduled] = yield* exec<{ at: number | null }>(
        "SELECT MIN(deliver_at) AS at FROM cluster_mailbox WHERE exit IS NULL AND deliver_at > ?",
        at,
      );
      if (scheduled?.at != null) next = Math.min(next, scheduled.at);
    }
    if (!Number.isFinite(next)) return;
    armedAt = next;
    yield* storage.setAlarm(next);
  });

  // ------------------------------------------------------------ instance

  const forget = (active: Active) => {
    actives.delete(active.id);
    if (byKey.get(active.key) === active) byKey.delete(active.key);
    for (const caller of active.callers) {
      if (byCaller.get(caller) === active) byCaller.delete(caller);
    }
    if (actives.size === 0) lastActive = now();
  };

  /** A message finished: store its reply, if persisted, and hand it to its callers. */
  const complete = (active: Active, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
    Effect.flatMap(encodeExit(active.rpc, exit), (encoded) =>
      locked(
        Effect.gen(function* () {
          if (actives.get(active.id) !== active) return;
          let reply = JSON.stringify(encoded);
          if (active.persisted) {
            if (tooLarge(reply)) {
              reply = JSON.stringify(
                yield* encodeExit(
                  active.rpc,
                  Exit.die(`The reply to ${active.key} is over ${limit} bytes and can't be stored`),
                ),
              );
            }
            // Stored before the message is forgotten: a duplicate arriving
            // now finds the run or its reply, never neither.
            const stored = yield* Effect.exit(
              exec(
                "UPDATE cluster_mailbox SET exit = ?, completed_at = ? WHERE request_id = ?",
                reply,
                now(),
                active.key,
              ),
            );
            if (Exit.isSuccess(stored)) pending--;
            // Its callers still get their reply; the alarm runs the message
            // again, as it does for one cut short.
            else yield* Effect.logError(`Could not store the reply to ${active.key}`, stored.cause);
          }
          forget(active);
          if (Exit.isSuccess(exit)) restarts = 0;
          Deferred.doneUnsafe(active.reply, Exit.succeed(reply));
          const waiting = waiters.get(active.key);
          waiters.delete(active.key);
          for (const waiter of waiting ?? []) Deferred.doneUnsafe(waiter, Exit.succeed(reply));
        }),
      ),
    ).pipe(Effect.andThen(drain));

  /** Stop `active`'s handler, from apart: its own fiber may be the one asking. */
  const stop = (active: Active) =>
    Effect.suspend(() =>
      instance === undefined || !active.delivered
        ? Effect.void
        : Effect.forkDetach(
            instance.server.write(0, {
              _tag: "Interrupt",
              requestId: RpcMessage.RequestId(active.id),
              interruptors: [],
            }),
          ),
    );

  const chunk = (active: Active, values: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const text = JSON.stringify(
        yield* Effect.forEach(values, (value) => encode(chunkCodec(active.rpc), value)),
      );
      if (!active.persisted) {
        for (const listener of active.listeners) yield* listener(text);
        return;
      }
      // Stored under the lock, so a caller joining the stream reads this
      // chunk from storage or hears it here, never both and never neither.
      const stored = tooLarge(text)
        ? Exit.die(`A chunk of ${active.key} is over ${limit} bytes and can't be stored`)
        : yield* locked(
            Effect.suspend(() =>
              exec(
                "INSERT OR REPLACE INTO cluster_chunks (request_id, seq, chunk) VALUES (?, ?, ?)",
                active.key,
                active.sequence++,
                text,
              ),
            ).pipe(
              Effect.map(() => [...active.listeners]),
              Effect.exit,
            ),
          );
      if (Exit.isFailure(stored)) {
        // A stream that can't be replayed in full fails where it stands.
        yield* complete(active, stored.cause.pipe(Cause.pretty, Exit.die));
        return yield* stop(active);
      }
      for (const listener of stored.value) yield* listener(text);
    });

  const onFromServer = (response: RpcMessage.FromServer<Rpc.Any>): Effect.Effect<void> => {
    switch (response._tag) {
      case "Exit": {
        const active = actives.get(Number(response.requestId));
        if (active === undefined) return Effect.void;
        // A restart's interrupts aren't replies: the rebuilt instance runs
        // the message again.
        if (restarting && Exit.hasInterrupts(response.exit) && !active.interrupted) {
          return Effect.void;
        }
        return complete(active, response.exit);
      }
      case "Chunk": {
        const active = actives.get(Number(response.requestId));
        return active === undefined ? Effect.void : chunk(active, response.values);
      }
      case "Defect":
        return restart(Cause.die(response.defect));
      case "ClientEnd":
        return Effect.void;
    }
  };

  const setKeepAlive = (enabled: boolean) =>
    Effect.gen(function* () {
      keepAlive = enabled;
      yield* exec(
        "INSERT OR REPLACE INTO cluster_entity (key, value) VALUES ('keep_alive', ?)",
        enabled ? 1 : 0,
      );
      lastActive = now();
      if (enabled) yield* arm(now() + KEEP_AWAKE);
    });

  /** Build the instance's handlers and the server they run behind, once. */
  const buildOnce = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = options.context.pipe(
      Context.add(CurrentAddress, address),
      Context.add(CurrentRunnerAddress, options.runnerAddress),
      Context.add(KeepAliveHandler, setKeepAlive),
      Context.add(Scope.Scope, scope),
    );
    return yield* Effect.gen(function* () {
      const handlers = yield* (
        entity.protocol.toHandlers(hosted.instance as never) as Effect.Effect<
          Context.Context<never>
        >
      ).pipe(Effect.provideContext(context));
      const makeServer = RpcServer.makeNoSerialization(entity.protocol, {
        onFromServer,
        spanPrefix: entity.type,
        spanAttributes: { "entity.type": entity.type, "entity.id": address.entityId },
        concurrency: hosted.options.concurrency ?? 1,
        disableFatalDefects: hosted.options.disableFatalDefects,
        // The object's reply stream is the backpressure.
        disableClientAcks: true,
      });
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- its handlers, middleware and scope are in the context provided below
      const serve = makeServer as Effect.Effect<RpcServer.RpcServer<Rpc.Any>>;
      const server = yield* serve.pipe(Effect.provideContext(Context.merge(context, handlers)));
      return { scope, server } satisfies Instance;
    }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
  });

  /** Build the instance, retrying a defect while building as Effect Cluster does. */
  const buildInstance = buildOnce.pipe(
    Effect.sandbox,
    Effect.tapError((cause) => Effect.logError("Defect building entity handlers", cause)),
    Effect.retry(restartPolicy),
    Effect.orDie,
  );

  /** The running instance, building it on its first message. */
  const getInstance: Effect.Effect<Instance> = Effect.suspend(() => {
    if (instance !== undefined) return Effect.succeed(instance);
    if (building !== undefined) return Deferred.await(building);
    const ready = Deferred.makeUnsafe<Instance>();
    building = ready;
    // Built apart from the caller, which may stop waiting.
    return Effect.forkDetach(
      Effect.flatMap(buildInstance, (built) =>
        Effect.sync(() => {
          instance = built;
          building = undefined;
          Deferred.doneUnsafe(ready, Exit.succeed(built));
        }),
      ).pipe(
        // Messages stored before this object last stopped run once the
        // instance is back.
        Effect.andThen(Effect.suspend(() => (replayed ? Effect.void : replayStored))),
      ),
    ).pipe(Effect.andThen(Deferred.await(ready)));
  });

  /** Write `active` to the instance's server, which runs its handler. */
  const deliver = (built: Instance, active: Active) =>
    Effect.suspend(() => {
      if (actives.get(active.id) !== active) return Effect.void;
      active.delivered = true;
      return built.server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(active.id),
        tag: active.rpc._tag,
        payload: active.request,
        headers: active.request.headers,
      } as RpcMessage.Request<Rpc.Any>);
    });

  const start = (active: Active) =>
    Effect.andThen(
      arm(now() + KEEP_AWAKE),
      Effect.flatMap(getInstance, (built) => deliver(built, active)),
    );

  /**
   * A handler died: stop the instance, back off, build it again, and run
   * every message it had started again, as Effect Cluster's runners do.
   */
  const restart = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (restarting) return Effect.void;
      restarting = true;
      const old = instance;
      instance = undefined;
      const ready = Deferred.makeUnsafe<Instance>();
      building = ready;
      // Effect Cluster's back-off: 500ms, growing by half each time, at most 10s.
      const delay = Math.min(500 * 1.5 ** restarts++, 10_000);
      return options.waitUntil(
        Effect.gen(function* () {
          yield* Effect.logError("Defect in entity, restarting", cause);
          if (old !== undefined) yield* Scope.close(old.scope, Exit.void);
          yield* Effect.sleep(delay);
          const built = yield* buildInstance;
          // The messages the old instance had started run again first; those
          // still waiting for an instance deliver themselves once it's ready.
          const started = [...actives.values()].filter((active) => active.delivered);
          for (const active of started) yield* deliver(built, active);
          instance = built;
          building = undefined;
          restarting = false;
          Deferred.doneUnsafe(ready, Exit.succeed(built));
        }),
      );
    });

  /** Stop an instance that has been idle for `maxIdleTime`, closing its scope. */
  const reapIfIdle = Effect.suspend(() => {
    if (instance === undefined || building !== undefined || restarting) return Effect.void;
    if (keepAlive || actives.size > 0 || now() - lastActive < maxIdle) return Effect.void;
    const old = instance;
    instance = undefined;
    return Scope.close(old.scope, Exit.void);
  });

  // ------------------------------------------------------------ mailbox

  const makeActive = (
    key: string,
    rpc: Rpc.AnyWithProps,
    payload: unknown,
    call: Call,
    persisted: boolean,
  ): Active => {
    const active: Active = {
      id: nextId++,
      key,
      rpc,
      request: new EntityRequest(
        Object.assign(
          Envelope.makeRequest({
            requestId: snowflakes.nextUnsafe(),
            address,
            tag: rpc._tag as never,
            payload: payload as never,
            headers: Headers.fromInput(call.headers),
          }),
          { lastSentChunk: Option.none() },
        ),
      ),
      persisted,
      callers: new Set(),
      reply: Deferred.makeUnsafe<string>(),
      listeners: new Set(),
      sequence: 0,
      delivered: false,
      interrupted: false,
    };
    actives.set(active.id, active);
    byKey.set(key, active);
    return active;
  };

  const join = (active: Active, caller: string | undefined) => {
    if (caller === undefined) return;
    active.callers.add(caller);
    byCaller.set(caller, active);
  };

  const waitFor = (key: string): Admission => {
    const reply = Deferred.makeUnsafe<string>();
    waiters.set(key, [...(waiters.get(key) ?? []), reply]);
    return waitOn(key, reply);
  };

  /**
   * Whether the instance holds its capacity of messages, running or waiting
   * for their turn to. As on Effect Cluster's runners, a stored message
   * waiting for its `DeliverAt` isn't one of them.
   */
  const full = () => capacity !== "unbounded" && actives.size >= capacity;

  /**
   * A stored message that is due but has to wait: the instance is full, or
   * others are waiting ahead of it.
   */
  const queued = (mode: "ask" | "tell" | "stream", key: string): Admission => {
    backlog = true;
    return mode === "tell" ? accepted : waitFor(key);
  };

  const storedChunks = (key: string) =>
    Effect.map(
      exec<{ chunk: string }>(
        "SELECT chunk FROM cluster_chunks WHERE request_id = ? ORDER BY seq",
        key,
      ),
      (rows) => rows.map((row) => row.chunk),
    );

  /**
   * Admit a call: run it, join the run already answering it, answer it
   * from storage, or reject it. Everything after decoding runs under the
   * mailbox's lock, so no other event sees the mailbox half-updated.
   */
  const admit = (
    call: Call,
    mode: "ask" | "tell" | "stream",
    /** Where a stream's chunks go, if it joins one already running. */
    listen: (chunk: string) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const rpc = entity.protocol.requests.get(call.tag) as Rpc.AnyWithProps | undefined;
      if (rpc === undefined) {
        return yield* Effect.die(new Error(`Entity '${entity.type}' has no RPC '${call.tag}'.`));
      }
      const payload = yield* decode(payloadCodec(rpc), call.payload);
      const persisted = Context.get(rpc.annotations, ClusterSchema.Persisted);
      const keyed = PrimaryKey.isPrimaryKey(payload);
      const deliverAt = DeliverAt.toMillis(payload);
      if (!persisted) {
        if (full()) return rejected("MailboxFull", `${entity.type} mailbox is full`);
        const active = makeActive(call.requestId, rpc, payload, call, false);
        join(active, call.requestId);
        return run(active);
      }
      const key = keyed ? `${rpc._tag}/${PrimaryKey.value(payload)}` : call.requestId;
      return yield* locked(
        Effect.gen(function* () {
          const running = byKey.get(key);
          if (running !== undefined) {
            // A duplicate waits for the first run's reply; giving up doesn't
            // interrupt the run.
            if (mode !== "stream") return mode === "tell" ? accepted : waitOn(key, running.reply);
            running.listeners.add(listen);
            return {
              _tag: "Join",
              active: running,
              chunks: yield* storedChunks(key),
            } satisfies Admission as Admission;
          }
          const at = now();
          const [row] = yield* exec<MailboxRow>(
            "SELECT request_id, call, exit, deliver_at FROM cluster_mailbox WHERE request_id = ?",
            key,
          );
          if (row?.exit != null) {
            return mode === "tell"
              ? accepted
              : replied(row.exit, mode === "stream" ? yield* storedChunks(key) : []);
          }
          if (row !== undefined) {
            if (row.deliver_at != null && row.deliver_at > at) {
              return mode === "tell" ? accepted : waitFor(key);
            }
            if (backlog || full()) return queued(mode, key);
            // Stored, but cut short by a restart: run it now, as it was sent.
            const stored = JSON.parse(row.call) as Call;
            const decoded = Schema.decodeUnknownExit(payloadCodec(rpc))(stored.payload);
            // Stored under an older schema: run the call as sent now.
            const active = makeActive(
              key,
              rpc,
              Exit.isSuccess(decoded) ? decoded.value : payload,
              Exit.isSuccess(decoded) ? stored : call,
              true,
            );
            join(active, call.requestId);
            return run(active);
          }
          const text = JSON.stringify(call);
          if (tooLarge(text)) {
            return rejected("PersistenceError", `The call ${key} is over ${limit} bytes`);
          }
          const stored = yield* Effect.exit(
            exec(
              "INSERT INTO cluster_mailbox (request_id, call, keyed, deliver_at, created_at) VALUES (?, ?, ?, ?, ?)",
              key,
              text,
              keyed ? 1 : 0,
              deliverAt,
              at,
            ),
          );
          if (Exit.isFailure(stored))
            return rejected("PersistenceError", Cause.pretty(stored.cause));
          pending++;
          if (deliverAt !== null && deliverAt > at) {
            // Its time is the alarm's to keep.
            yield* arm(deliverAt);
            return mode === "tell" ? accepted : waitFor(key);
          }
          // A full instance doesn't turn a stored message away: it runs once
          // there is room, after those stored before it.
          if (backlog || full()) return queued(mode, key);
          const active = makeActive(key, rpc, payload, call, true);
          join(active, call.requestId);
          return run(active);
        }),
        // A message queued while the instance has room runs now.
      ).pipe(Effect.tap(() => drain));
    });

  /**
   * Run the stored messages whose time has come and that aren't running,
   * oldest first, as far as the instance has room.
   */
  const replayStored: Effect.Effect<void> = Effect.suspend(() => {
    replayed = true;
    if (pending === 0) {
      backlog = false;
      return Effect.void;
    }
    return locked(
      Effect.gen(function* () {
        // Those running are among the oldest, so the instance's capacity and
        // one more row tell whether any are left waiting.
        const rows = yield* exec<MailboxRow>(
          `SELECT request_id, call FROM cluster_mailbox WHERE exit IS NULL AND (deliver_at IS NULL OR deliver_at <= ?) ORDER BY created_at, rowid${
            capacity === "unbounded" ? "" : ` LIMIT ${capacity + 1}`
          }`,
          now(),
        );
        const started: Array<Active> = [];
        const dropped: Array<string> = [];
        backlog = false;
        for (const row of rows) {
          if (byKey.has(row.request_id)) continue;
          if (full()) {
            backlog = true;
            break;
          }
          const call = JSON.parse(row.call) as Call;
          const rpc = entity.protocol.requests.get(call.tag) as Rpc.AnyWithProps | undefined;
          const payload =
            rpc === undefined
              ? undefined
              : Schema.decodeUnknownExit(payloadCodec(rpc))(call.payload);
          if (rpc === undefined || payload === undefined || Exit.isFailure(payload)) {
            // The entity no longer accepts it: its RPCs changed since it was stored.
            yield* exec("DELETE FROM cluster_mailbox WHERE request_id = ?", row.request_id);
            pending--;
            dropped.push(row.request_id);
            continue;
          }
          started.push(makeActive(row.request_id, rpc, payload.value, call, true));
        }
        return { started, dropped };
      }),
    ).pipe(
      Effect.flatMap(({ started, dropped }) => {
        const logDropped =
          dropped.length === 0
            ? Effect.void
            : Effect.logError(
                `Dropped stored ${entity.type} messages its RPCs no longer accept`,
                dropped,
              );
        if (started.length === 0) return logDropped;
        return Effect.flatMap(getInstance, (built) =>
          Effect.forEach(started, (active) => deliver(built, active), { discard: true }),
        ).pipe(
          Effect.andThen(
            options.waitUntil(
              Effect.forEach(started, (active) => Deferred.await(active.reply), { discard: true }),
            ),
          ),
          Effect.andThen(logDropped),
        );
      }),
    );
  });

  /** Run waiting stored messages, in the background, once the instance has room for one. */
  const drain: Effect.Effect<void> = Effect.suspend(() =>
    backlog && !full() ? options.waitUntil(replayStored) : Effect.void,
  );

  /** A caller stopped waiting: interrupt its message, unless it is uninterruptible. */
  const interrupt = (caller: string) =>
    Effect.suspend(() => {
      const active = byCaller.get(caller);
      if (active === undefined) {
        // Its call may still be on its way: the two reach the object apart.
        const at = now();
        for (const [left, since] of leftEarly) {
          if (at - since < KEEP_INTERRUPTS) break;
          leftEarly.delete(left);
        }
        leftEarly.set(caller, at);
        return Effect.void;
      }
      if (ClusterSchema.isUninterruptibleForServer(active.rpc.annotations)) return Effect.void;
      active.interrupted = true;
      if (!active.delivered || instance === undefined) return complete(active, Exit.interrupt());
      return instance.server.write(0, {
        _tag: "Interrupt",
        requestId: RpcMessage.RequestId(active.id),
        interruptors: [],
      });
    });

  /**
   * Start a message its caller sent, unless the caller has already left:
   * then the message is interrupted before it runs, as Effect Cluster's
   * runners do.
   */
  const begin = (active: Active, caller: string) =>
    Effect.suspend(() => {
      if (!leftEarly.delete(caller)) return start(active);
      return Effect.andThen(
        interrupt(caller),
        // An uninterruptible message runs whether or not anyone waits.
        Effect.suspend(() => (active.interrupted ? Effect.void : start(active))),
      );
    });

  const ask = (call: Call) =>
    Effect.gen(function* () {
      const admission = yield* admit(call, "ask");
      switch (admission._tag) {
        case "Rejected":
          return JSON.stringify({ rejected: admission.rejection });
        case "Replied":
          return replyText(admission.reply);
        case "Accepted":
        case "Join":
          return yield* Effect.die(new Error("An ask was accepted without a reply"));
        case "Wait":
          return replyText(yield* Deferred.await(admission.reply));
        case "Run":
          yield* begin(admission.active, call.requestId);
          return replyText(yield* Deferred.await(admission.active.reply));
      }
    });

  /** A discarded call: answered once it is stored (or started), not once it runs. */
  const tell = (call: Call) =>
    Effect.gen(function* () {
      const admission = yield* admit(call, "tell");
      if (admission._tag === "Rejected") return JSON.stringify({ rejected: admission.rejection });
      if (admission._tag === "Run") {
        const active = admission.active;
        yield* options.waitUntil(Effect.andThen(start(active), Deferred.await(active.reply)));
      }
      return "{}";
    });

  const stream = (call: Call) =>
    Stream.callback<string>((queue) => {
      const offer = (frame: string) => Queue.offer(queue, frame);
      const emit = (chunk: string) => Effect.asVoid(offer(`{"chunk":${chunk}}`));
      // Chunks sent while this caller is still reading the stored ones wait
      // behind them.
      const caughtUp = Deferred.makeUnsafe<void>();
      const listen = (chunk: string) => Effect.andThen(Deferred.await(caughtUp), emit(chunk));
      // The run this caller is listening to, which it stops hearing when it leaves.
      let heard: Active | undefined;
      return Effect.gen(function* () {
        const admission = yield* admit(call, "stream", listen);
        switch (admission._tag) {
          case "Rejected":
            yield* offer(JSON.stringify({ rejected: admission.rejection }));
            break;
          case "Replied":
            for (const chunk of admission.chunks) yield* offer(`{"chunk":${chunk}}`);
            yield* offer(replyText(admission.reply));
            break;
          case "Accepted":
            return yield* Effect.die(new Error("A stream was accepted without a reply"));
          case "Join": {
            heard = admission.active;
            for (const chunk of admission.chunks) yield* emit(chunk);
            Deferred.doneUnsafe(caughtUp, Exit.void);
            yield* offer(replyText(yield* Deferred.await(admission.active.reply)));
            break;
          }
          case "Wait": {
            // A stored message's reply: its chunks are read from storage once it ends.
            const reply = yield* Deferred.await(admission.reply);
            for (const chunk of yield* storedChunks(admission.key)) {
              yield* offer(`{"chunk":${chunk}}`);
            }
            yield* offer(replyText(reply));
            break;
          }
          case "Run": {
            const active = admission.active;
            heard = active;
            Deferred.doneUnsafe(caughtUp, Exit.void);
            active.listeners.add(listen);
            const reply = yield* Effect.andThen(
              begin(active, call.requestId),
              Deferred.await(active.reply),
            ).pipe(
              // The caller stopped reading.
              Effect.onInterrupt(() => interrupt(call.requestId)),
            );
            yield* offer(replyText(reply));
            break;
          }
        }
        yield* Queue.end(queue);
      }).pipe(
        // A caller that leaves mustn't hold up the stream's other readers.
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(caughtUp, Exit.void);
            heard?.listeners.delete(listen);
          }),
        ),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.andThen(
              offer(JSON.stringify({ [DEFECT]: Cause.pretty(cause) })),
              Queue.end(queue),
            ),
        ),
      );
    });

  /**
   * The object's alarm: start a held instance its object lost, run stored
   * messages that are due, stop an idle instance, and wake again when
   * anything is left.
   */
  const alarm = Effect.gen(function* () {
    armedAt = undefined;
    if (keepAlive && instance === undefined) yield* getInstance;
    yield* replayStored;
    yield* reapIfIdle;
    if (now() - prunedAt < PRUNE_EVERY) return;
    prunedAt = now();
    const cutoff = now() - KEEP_REPLIES;
    yield* exec(
      "DELETE FROM cluster_chunks WHERE request_id IN (SELECT request_id FROM cluster_mailbox WHERE keyed = 0 AND completed_at < ?)",
      cutoff,
    );
    yield* exec("DELETE FROM cluster_mailbox WHERE keyed = 0 AND completed_at < ?", cutoff);
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Entity alarm failed", cause)),
    Effect.ensuring(Effect.ignore(rearm)),
    Effect.ignore,
  );

  return { ask, tell, stream, interrupt, alarm };
});
