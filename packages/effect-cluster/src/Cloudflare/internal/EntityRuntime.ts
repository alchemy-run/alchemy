/**
 * One entity instance on its Durable Object, run the way Effect Cluster's
 * runners run one (`effect/cluster`'s entity manager):
 *
 * - The instance's handlers run behind Effect's own `RpcServer`, which
 *   applies the RPCs' middleware, the entity's `concurrency`, `Rpc.fork`
 *   and `Rpc.uninterruptible`.
 * - A persisted message is stored before it runs and its reply after: a
 *   primary key runs once, a duplicate waits for the first run's reply, and
 *   a message cut short by a restart runs again when the object next wakes.
 * - A message with `DeliverAt` waits in storage until its time, which the
 *   object's alarm wakes it for.
 * - A defect restarts the instance, backing off, and runs its messages
 *   again, unless `disableFatalDefects` returns it to the caller.
 * - The instance stops once idle for `maxIdleTime`, closing its scope,
 *   unless `Entity.keepAlive` holds it; a held instance is started again
 *   after its object restarts.
 *
 * Cloudflare evicts an object idle for about ten seconds, and the instance's
 * memory with it, so the object's alarm keeps it awake while its instance
 * runs.
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
import * as Stream from "effect/Stream";
import type { HostedEntity } from "../../Entity.ts";
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

/** Effect Cluster's back-off between attempts to build an instance. */
const restartPolicy = Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced("10 seconds")]);

/** The parts of workerd's `DurableObjectStorage` the runtime uses, synchronously. */
export interface NativeStorage {
  readonly sql: {
    exec(query: string, ...bindings: ReadonlyArray<unknown>): { toArray(): Array<unknown> };
  };
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface EntityRuntimeOptions {
  readonly hosted: HostedEntity;
  readonly address: EntityAddress;
  readonly runnerAddress: RunnerAddress;
  /** What the instance runs with: its Construction phase's services and the cluster's. */
  readonly context: Context.Context<never>;
  readonly storage: NativeStorage;
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
  /** Where its stream's chunks go, encoded. */
  onChunk: ((chunk: ReadonlyArray<unknown>) => Effect.Effect<void>) | undefined;
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
  | { readonly _tag: "Wait"; readonly reply: Deferred.Deferred<string> }
  | { readonly _tag: "Replied"; readonly reply: string; readonly chunks: ReadonlyArray<string> }
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

const replyText = (reply: string) => `{"exit":${reply}}`;

export const makeEntityRuntime = Effect.fn(function* (options: EntityRuntimeOptions) {
  const { hosted, address, storage } = options;
  const entity = hosted.entity;
  const exec = <T>(query: string, ...bindings: ReadonlyArray<unknown>) =>
    storage.sql.exec(query, ...bindings).toArray() as Array<T>;

  const migratedAt = yield* Clock.currentTimeMillis;
  yield* Effect.sync(() =>
    storage.transactionSync(() => {
      exec(
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
      exec(
        "CREATE TABLE IF NOT EXISTS cluster_chunks (request_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (request_id, seq))",
      );
      exec(
        "CREATE TABLE IF NOT EXISTS cluster_entity (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      );
      // The mailbox's first layout: its rows move over, keeping their replies.
      exec(
        "CREATE TABLE IF NOT EXISTS cluster_messages (request_id TEXT PRIMARY KEY, call TEXT NOT NULL, exit TEXT)",
      );
      exec(
        `INSERT OR IGNORE INTO cluster_mailbox (request_id, call, keyed, exit, created_at, completed_at)
         SELECT request_id, call, instr(request_id, '/') > 0, exit, ?, CASE WHEN exit IS NULL THEN NULL ELSE ? END
         FROM cluster_messages`,
        migratedAt,
        migratedAt,
      );
      exec("DROP TABLE cluster_messages");
    }),
  );

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
  /** Callers waiting on a message whose `DeliverAt` hasn't come. */
  const waiters = new Map<string, Array<Deferred.Deferred<string>>>();
  let nextId = 0;
  let instance: Instance | undefined;
  let building: Deferred.Deferred<Instance> | undefined;
  let restarting = false;
  let restarts = 0;
  let replayed = false;
  let lastActive = now();
  let keepAlive =
    exec<{ value: number }>("SELECT value FROM cluster_entity WHERE key = 'keep_alive'")[0]
      ?.value === 1;
  let armedAt: number | undefined = (yield* Effect.promise(() => storage.getAlarm())) ?? undefined;

  // ------------------------------------------------------------ alarm

  /** Wake the object at `at`, unless it already wakes sooner. */
  const arm = (at: number) =>
    Effect.suspend(() => {
      if (armedAt !== undefined && armedAt > now() && armedAt <= at) return Effect.void;
      armedAt = at;
      return Effect.promise(() => storage.setAlarm(at));
    });

  /** The next time the object must wake: for its instance, a replay, or a scheduled message. */
  const rearm = Effect.suspend(() => {
    const at = now();
    let next = Number.POSITIVE_INFINITY;
    if (instance !== undefined || keepAlive) next = at + KEEP_AWAKE;
    // A stored message that is due but not done: its run may have been cut short.
    const [due] = exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cluster_mailbox WHERE exit IS NULL AND (deliver_at IS NULL OR deliver_at <= ?)",
      at,
    );
    if ((due?.n ?? 0) > 0) next = Math.min(next, at + REPLAY_AFTER);
    const [scheduled] = exec<{ at: number | null }>(
      "SELECT MIN(deliver_at) AS at FROM cluster_mailbox WHERE exit IS NULL AND deliver_at > ?",
      at,
    );
    if (scheduled?.at != null) next = Math.min(next, scheduled.at);
    if (!Number.isFinite(next)) return Effect.void;
    armedAt = next;
    return Effect.promise(() => storage.setAlarm(next));
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
  const complete = (active: Active, exit: Exit.Exit<unknown, unknown>) =>
    Effect.flatMap(encodeExit(active.rpc, exit), (encoded) =>
      Effect.sync(() => {
        if (actives.get(active.id) !== active) return;
        const reply = JSON.stringify(encoded);
        forget(active);
        if (active.persisted) {
          exec(
            "UPDATE cluster_mailbox SET exit = ?, completed_at = ? WHERE request_id = ?",
            reply,
            now(),
            active.key,
          );
        }
        if (Exit.isSuccess(exit)) restarts = 0;
        Deferred.doneUnsafe(active.reply, Exit.succeed(reply));
        const waiting = waiters.get(active.key);
        waiters.delete(active.key);
        for (const waiter of waiting ?? []) Deferred.doneUnsafe(waiter, Exit.succeed(reply));
      }),
    );

  const chunk = (active: Active, values: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const encoded = yield* Effect.forEach(values, (value) =>
        encode(chunkCodec(active.rpc), value),
      );
      if (active.persisted) {
        exec(
          "INSERT OR REPLACE INTO cluster_chunks (request_id, seq, chunk) VALUES (?, ?, ?)",
          active.key,
          active.sequence,
          JSON.stringify(encoded),
        );
      }
      active.sequence++;
      if (active.onChunk !== undefined) yield* active.onChunk(encoded);
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
    Effect.suspend(() => {
      keepAlive = enabled;
      exec(
        "INSERT OR REPLACE INTO cluster_entity (key, value) VALUES ('keep_alive', ?)",
        enabled ? 1 : 0,
      );
      lastActive = now();
      return enabled ? arm(now() + KEEP_AWAKE) : Effect.void;
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
      const server = yield* (
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- its handlers, middleware and scope are in the context provided below
        (
          RpcServer.makeNoSerialization(entity.protocol, {
            onFromServer,
            spanPrefix: entity.type,
            spanAttributes: { "entity.type": entity.type, "entity.id": address.entityId },
            concurrency: hosted.options.concurrency ?? 1,
            disableFatalDefects: hosted.options.disableFatalDefects,
            // The object's reply stream is the backpressure.
            disableClientAcks: true,
          }) as Effect.Effect<RpcServer.RpcServer<Rpc.Any>>
        ).pipe(Effect.provideContext(Context.merge(context, handlers)))
      );
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
      onChunk: undefined,
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
    return { _tag: "Wait", reply };
  };

  const full = () => capacity !== "unbounded" && actives.size >= capacity;

  const storedChunks = (key: string) =>
    exec<{ chunk: string }>(
      "SELECT chunk FROM cluster_chunks WHERE request_id = ? ORDER BY seq",
      key,
    ).map((row) => row.chunk);

  /**
   * Admit a call: run it, join the run already answering it, answer it
   * from storage, or reject it. Everything after decoding runs without
   * yielding, so no other event sees the mailbox half-updated.
   */
  const admit = (call: Call, mode: "ask" | "tell" | "stream") =>
    Effect.gen(function* () {
      const rpc = entity.protocol.requests.get(call.tag) as Rpc.AnyWithProps | undefined;
      if (rpc === undefined) {
        return yield* Effect.die(new Error(`Entity '${entity.type}' has no RPC '${call.tag}'.`));
      }
      const payload = yield* decode(payloadCodec(rpc), call.payload);
      return yield* Effect.sync((): Admission => {
        if (!Context.get(rpc.annotations, ClusterSchema.Persisted)) {
          if (full()) return rejected("MailboxFull", `${entity.type} mailbox is full`);
          const active = makeActive(call.requestId, rpc, payload, call, false);
          join(active, call.requestId);
          return { _tag: "Run", active };
        }
        const keyed = PrimaryKey.isPrimaryKey(payload);
        const key = keyed ? `${rpc._tag}/${PrimaryKey.value(payload)}` : call.requestId;
        const running = byKey.get(key);
        if (running !== undefined) {
          if (mode === "tell") return { _tag: "Accepted" };
          // A stream's chunks went to the caller that started it.
          if (mode === "stream") {
            return rejected("AlreadyProcessingMessage", `${key} is already running`);
          }
          // A duplicate waits for the first run's reply; giving up doesn't
          // interrupt it.
          return { _tag: "Wait", reply: running.reply };
        }
        const at = now();
        const [row] = exec<MailboxRow>(
          "SELECT request_id, call, exit, deliver_at FROM cluster_mailbox WHERE request_id = ?",
          key,
        );
        if (row?.exit != null) {
          return mode === "tell"
            ? { _tag: "Accepted" }
            : {
                _tag: "Replied",
                reply: row.exit,
                chunks: mode === "stream" ? storedChunks(key) : [],
              };
        }
        if (row !== undefined) {
          if (row.deliver_at != null && row.deliver_at > at) {
            return mode === "tell" ? { _tag: "Accepted" } : waitFor(key);
          }
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
          return { _tag: "Run", active };
        }
        if (full()) return rejected("MailboxFull", `${entity.type} mailbox is full`);
        const deliverAt = DeliverAt.toMillis(payload);
        try {
          exec(
            "INSERT INTO cluster_mailbox (request_id, call, keyed, deliver_at, created_at) VALUES (?, ?, ?, ?, ?)",
            key,
            JSON.stringify(call),
            keyed ? 1 : 0,
            deliverAt,
            at,
          );
        } catch (cause) {
          return rejected("PersistenceError", String(cause));
        }
        if (deliverAt !== null && deliverAt > at) {
          return mode === "tell" ? { _tag: "Accepted" } : waitFor(key);
        }
        const active = makeActive(key, rpc, payload, call, true);
        join(active, call.requestId);
        return { _tag: "Run", active };
      });
    });

  /** Run every stored message whose time has come and that isn't running. */
  const replayStored: Effect.Effect<void> = Effect.suspend(() => {
    replayed = true;
    const rows = exec<MailboxRow>(
      "SELECT request_id, call FROM cluster_mailbox WHERE exit IS NULL AND (deliver_at IS NULL OR deliver_at <= ?) ORDER BY created_at",
      now(),
    );
    const started: Array<Active> = [];
    const dropped: Array<string> = [];
    for (const row of rows) {
      if (byKey.has(row.request_id)) continue;
      const call = JSON.parse(row.call) as Call;
      const rpc = entity.protocol.requests.get(call.tag) as Rpc.AnyWithProps | undefined;
      const payload =
        rpc === undefined ? undefined : Schema.decodeUnknownExit(payloadCodec(rpc))(call.payload);
      if (rpc === undefined || payload === undefined || Exit.isFailure(payload)) {
        // The entity no longer accepts it: its RPCs changed since it was stored.
        exec("DELETE FROM cluster_mailbox WHERE request_id = ?", row.request_id);
        dropped.push(row.request_id);
        continue;
      }
      started.push(makeActive(row.request_id, rpc, payload.value, call, true));
    }
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
  });

  /** A caller stopped waiting: interrupt its message, unless it is uninterruptible. */
  const interrupt = (caller: string) =>
    Effect.suspend(() => {
      const active = byCaller.get(caller);
      if (active === undefined) return Effect.void;
      if (ClusterSchema.isUninterruptibleForServer(active.rpc.annotations)) return Effect.void;
      active.interrupted = true;
      if (!active.delivered || instance === undefined) return complete(active, Exit.interrupt());
      return instance.server.write(0, {
        _tag: "Interrupt",
        requestId: RpcMessage.RequestId(active.id),
        interruptors: [],
      });
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
          return yield* Effect.die(new Error("An ask was accepted without a reply"));
        case "Wait":
          return replyText(yield* Deferred.await(admission.reply));
        case "Run":
          yield* start(admission.active);
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
      return Effect.gen(function* () {
        const admission = yield* admit(call, "stream");
        switch (admission._tag) {
          case "Rejected":
            yield* offer(JSON.stringify({ rejected: admission.rejection }));
            break;
          case "Replied":
            for (const chunk of admission.chunks) yield* offer(`{"chunk":${chunk}}`);
            yield* offer(replyText(admission.reply));
            break;
          case "Accepted":
          case "Wait":
            return yield* Effect.die(new Error("A stream was admitted without running"));
          case "Run": {
            const active = admission.active;
            active.onChunk = (encoded) => Effect.asVoid(offer(JSON.stringify({ chunk: encoded })));
            const reply = yield* Effect.andThen(start(active), Deferred.await(active.reply)).pipe(
              // The caller stopped reading.
              Effect.onInterrupt(() => interrupt(call.requestId)),
            );
            yield* offer(replyText(reply));
            break;
          }
        }
        yield* Queue.end(queue);
      }).pipe(
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
    const cutoff = now() - KEEP_REPLIES;
    exec(
      "DELETE FROM cluster_chunks WHERE request_id IN (SELECT request_id FROM cluster_mailbox WHERE keyed = 0 AND completed_at < ?)",
      cutoff,
    );
    exec("DELETE FROM cluster_mailbox WHERE keyed = 0 AND completed_at < ?", cutoff);
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Entity alarm failed", cause)),
    Effect.ensuring(Effect.ignore(rearm)),
    Effect.ignore,
  );

  return { ask, tell, stream, interrupt, alarm };
});
