import {
  CurrentActivity,
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Workflow, WorkflowEngine } from "effect/workflow";
import type * as Aggregate from "./Aggregate.ts";
import { isAfter, mergeCheckpoints } from "./InMemory.ts";
import {
  type Accepted,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  type Json,
  Platform,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamMeta,
  type ViewEntry,
  type ViewSnapshot,
} from "./Platform.ts";
import {
  type Reader,
  Storage,
  type StorageError,
  type Timer,
  type Transaction,
} from "./Storage.ts";

/**
 * Options for {@link layer}.
 */
export interface Options {
  /**
   * How often each process looks for due timers: scheduled commands, saga
   * clocks, projection batches, and work another process started but did not
   * finish.
   * @default 1000
   */
  readonly pollMillis?: number;
  /**
   * How often a live read re-reads its key, to see commits made by other
   * processes. Commits made by this process are seen at once.
   * @default 500
   */
  readonly watchMillis?: number;
}

/** When work kicked off in-process has not finished by then, a timer runs it (in any process). */
const BACKSTOP_MS = 10_000;
/** How long a fired timer is held by the process that fired it before it may fire again. */
const CLAIM_MS = 30_000;
/** How long a run holds its partition's work; renewed while the run lasts. */
const LEASE_MS = 30_000;
/** How long failed work waits before it is retried. */
const RETRY_MS = 10_000;
/** Timers due sooner than this are also fired in-process, without waiting for a poll. */
const LOCAL_HORIZON_MS = 60_000;
/** Timers fired per poll. */
const POLL_BATCH = 100;

const pad = (n: number) => n.toString().padStart(12, "0");

/** One kind of partition: `aggregate/Account`, `view/AccountSummary`, `workflow/ExecuteTransfer`. */
const scopeOf = (kind: string, name: string) => `${kind}/${encodeURIComponent(name)}`;

/** Split a partition into its scope and its key (which may contain anything). */
const parse = (partition: string) => {
  const first = partition.indexOf("/");
  const second = partition.indexOf("/", first + 1);
  return { scope: partition.slice(0, second), key: partition.slice(second + 1) };
};

/** A run could not renew its lease in time: another run may hold it now. */
class LeaseLost extends Data.TaggedError("LeaseLost")<{}> {}

/** A run's hold on one partition's work. */
interface Lease {
  readonly token: string;
  readonly until: number;
}

/** The stored progress of one projection key. */
interface ProjectionMeta {
  /** Inputs accepted into the log. */
  readonly accepted: number;
  /** Inputs handled. */
  readonly processed: number;
  /** The last accepted `seq` per source: duplicates are dropped on arrival. */
  readonly intake: Readonly<Record<string, number>>;
  /** The last handled `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
}

const emptyProjectionMeta: ProjectionMeta = {
  accepted: 0,
  processed: 0,
  intake: {},
  checkpoints: {},
};

/** A stored saga run. */
interface ExecutionRow {
  readonly executionId: string;
  readonly payload: Json;
  readonly parent: { readonly workflowName: string; readonly executionId: string } | null;
  readonly interrupted: boolean;
  /** The encoded result, once the run has finished. */
  readonly result: string | null;
}

type AnyWorkflow = Workflow.AnyWithProps;

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

/** What a fired timer runs, given its partition's key and the timer's name. */
type TimerHandler = (key: string, name: string) => Effect.Effect<void>;

/**
 * Build a platform and workflow engine over the ambient {@link Storage}.
 */
export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const storage = yield* Storage;
    const pollMillis = options.pollMillis ?? 1_000;
    const watchMillis = options.watchMillis ?? 500;
    // Background work lives as long as the platform's Layer.
    const lifetime: Scope.Scope = yield* Effect.scope;
    const background = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.forkIn(effect, lifetime).pipe(Effect.asVoid);

    // A storage failure is a defect of the operation it interrupts; durable
    // work is retried by its timer.
    const transact = <A, R>(
      partition: string,
      f: (tx: Transaction) => Effect.Effect<A, StorageError, R>,
    ): Effect.Effect<A, never, R> => Effect.orDie(storage.transact(partition, f));
    const read = <A, R>(
      partition: string,
      f: (reader: Reader) => Effect.Effect<A, StorageError, R>,
    ): Effect.Effect<A, never, R> => Effect.orDie(storage.read(partition, f));

    // Partitions committed by this process, so its live reads update at once.
    // Sliding: a slow watcher drops old signals rather than buffering them;
    // its next poll still sees the latest state.
    const commits = yield* PubSub.sliding<string>(4096);
    const notify = (partition: string) => PubSub.publish(commits, partition).pipe(Effect.asVoid);
    /** A tick after every local commit to `partition`, and every `watchMillis`. */
    const ticks = (partition: string): Stream.Stream<void> =>
      Stream.merge(
        Stream.fromPubSub(commits).pipe(
          Stream.filter((committed) => committed === partition),
          Stream.map(() => undefined),
        ),
        Stream.tick(Duration.millis(watchMillis)),
      );

    /**
     * Live reads of one kind of partition. Each watched key has one poller,
     * shared by all its watchers, that re-reads it on every tick and publishes
     * the value only when its version moves; watchers of entries read them
     * only then. Load grows with watched keys, not with watchers.
     */
    const watcher = <A>(
      partitionOf: (key: string) => string,
      readValue: (key: string) => Effect.Effect<A>,
      versionOf: (value: A) => number,
    ) =>
      RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const ref = yield* SubscriptionRef.make(yield* readValue(key));
            yield* ticks(partitionOf(key)).pipe(
              Stream.mapEffect(() => readValue(key)),
              Stream.runForEach((value) =>
                Effect.flatMap(SubscriptionRef.get(ref), (current) =>
                  versionOf(value) === versionOf(current)
                    ? Effect.void
                    : SubscriptionRef.set(ref, value),
                ),
              ),
              Effect.forkScoped,
            );
            return ref;
          }),
      }).pipe(
        Effect.provideService(Scope.Scope, lifetime),
        Effect.map((shared) => {
          /** The current value, then every new version. */
          const changes = (key: string): Stream.Stream<A> =>
            Stream.unwrap(Effect.map(RcMap.get(shared, key), SubscriptionRef.changes));
          /** Entries after a cursor, then new ones as versions move. */
          const tail = <E>(
            key: string,
            after: number,
            readAfter: (cursor: number) => Effect.Effect<ReadonlyArray<E>>,
            seqOf: (entry: E) => number,
          ): Stream.Stream<E> =>
            Stream.suspend(() => {
              let cursor = after;
              return changes(key).pipe(
                Stream.mapEffect(() =>
                  readAfter(cursor).pipe(
                    Effect.tap((fresh) =>
                      Effect.sync(() => {
                        if (fresh.length > 0) cursor = seqOf(fresh[fresh.length - 1]!);
                      }),
                    ),
                  ),
                ),
                Stream.flattenIterable,
              );
            });
          return { changes, tail };
        }),
      );

    // ------------------------------------------------------------ timers

    const handlers = new Map<string, TimerHandler>();

    /**
     * Fire a due timer: claim it (push its due time out, so no other process
     * fires it meanwhile), then run its handler. A handler that dies leaves
     * the timer to fire again once the claim lapses.
     */
    const fire = (timer: Timer): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { scope, key } = parse(timer.partition);
        // Not hosted here yet (the Layer is still building): leave it.
        const handler = handlers.get(scope);
        if (!handler) return;
        const now = yield* Clock.currentTimeMillis;
        const claimed = yield* transact(timer.partition, (tx) =>
          Effect.gen(function* () {
            if ((yield* tx.timer(timer.name)) !== Math.floor(timer.at)) return false;
            yield* tx.setTimer(timer.name, now + CLAIM_MS);
            return true;
          }),
        );
        if (claimed) yield* handler(key, timer.name);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`Domain timer ${timer.name} of ${timer.partition} failed`, cause),
        ),
      );

    /** Local fires already waiting, so a timer set again for the same time waits once. */
    const waiting = new Set<string>();
    /** Also fire a soon-due timer from this process, rather than waiting for a poll. */
    const later = (partition: string, name: string, at: number) =>
      Effect.gen(function* () {
        const due = Math.floor(at);
        const wait = due - (yield* Clock.currentTimeMillis);
        const id = `${partition}\u0000${name}\u0000${due}`;
        if (wait > LOCAL_HORIZON_MS || waiting.has(id)) return;
        waiting.add(id);
        yield* background(
          Effect.sleep(Duration.millis(Math.max(0, wait))).pipe(
            Effect.andThen(fire({ partition, name, at: due })),
            Effect.ensuring(Effect.sync(() => waiting.delete(id))),
          ),
        );
      });

    yield* background(
      Effect.gen(function* () {
        // Only timers of entities hosted here: others' (another model sharing
        // the tables, an entity since removed) must not crowd ours out.
        const scopes = [...handlers.keys()].map((scope) => `${scope}/`);
        const due = yield* storage.due(yield* Clock.currentTimeMillis, POLL_BATCH, scopes);
        yield* Effect.forEach(due, fire, { concurrency: 16, discard: true });
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("Domain timer poll failed", cause)),
        Effect.repeat(Schedule.spaced(Duration.millis(pollMillis))),
      ),
    );

    // ------------------------------------------------------------ workers

    /**
     * Durable background work on a partition, run by one process at a time.
     * `signal`, inside the transaction that creates work, records it and sets
     * a backstop timer; `kick`, after the commit, runs it now in this process.
     * A run holds a lease, does the work, and ends only when no signal came
     * in meanwhile; work that fails is retried by the timer. `work` returns
     * when it wants to run next (a batch still filling), if at all.
     */
    const worker = (
      scope: string,
      name: string,
      work: (key: string) => Effect.Effect<number | undefined>,
    ) => {
      const leaseKey = `${name}-lease`;
      const wakesKey = `${name}-wakes`;
      const partitionOf = (key: string) => `${scope}/${key}`;

      const signal = (tx: Transaction) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* tx.put({ [wakesKey]: ((yield* tx.get<number>(wakesKey)) ?? 0) + 1 });
          const at = yield* tx.timer(name);
          if (at === undefined || at > now + BACKSTOP_MS)
            yield* tx.setTimer(name, now + BACKSTOP_MS);
        });

      const runOnce = (key: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const partition = partitionOf(key);
          const token = yield* Effect.sync(() => crypto.randomUUID());
          const acquired = yield* transact(partition, (tx) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const held = yield* tx.get<Lease>(leaseKey);
              if (held !== undefined && held.until > now) {
                // Another run holds it, and will see this signal before it
                // ends. Should that run's process have died, the timer runs
                // the work as soon as its lease lapses.
                const at = yield* tx.timer(name);
                if (at !== undefined && at > held.until) yield* tx.setTimer(name, held.until);
                return undefined;
              }
              const until = now + LEASE_MS;
              yield* tx.put({ [leaseKey]: { token, until } satisfies Lease });
              return until;
            }),
          );
          if (acquired === undefined) return;
          let heldUntil = acquired;
          /** Is the lease still this run's? Timers and the lease are only touched while it is. */
          const ours = (tx: Transaction) =>
            Effect.map(tx.get<Lease>(leaseKey), (held) => held?.token === token);
          const renew = transact(partition, (tx) =>
            Effect.gen(function* () {
              if (!(yield* ours(tx))) return undefined;
              const until = (yield* Clock.currentTimeMillis) + LEASE_MS;
              yield* tx.put({ [leaseKey]: { token, until } satisfies Lease });
              return until;
            }),
          );
          // Renew the lease while the work runs. When it was taken over, or
          // can't be renewed before it lapses, stop: another run may start.
          const heartbeat = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(Duration.millis(LEASE_MS / 3));
              const renewed = yield* Effect.exit(renew);
              if (Exit.isSuccess(renewed)) {
                if (renewed.value === undefined) return yield* new LeaseLost();
                heldUntil = renewed.value;
              } else if ((yield* Clock.currentTimeMillis) >= heldUntil - LEASE_MS / 3) {
                return yield* new LeaseLost();
              }
            }
          });
          yield* Effect.gen(function* () {
            while (true) {
              const wakes = yield* read(partition, (r) => r.get<number>(wakesKey));
              const exit = yield* Effect.exit(work(key));
              if (Exit.isFailure(exit)) {
                yield* Effect.logError(
                  `Domain ${name} of ${partition} failed; retrying`,
                  exit.cause,
                );
                const at = (yield* Clock.currentTimeMillis) + RETRY_MS;
                yield* transact(partition, (tx) =>
                  Effect.gen(function* () {
                    if (!(yield* ours(tx))) return;
                    yield* tx.delete([leaseKey]);
                    yield* tx.setTimer(name, at);
                  }),
                );
                return;
              }
              const next = exit.value;
              const done = yield* transact(partition, (tx) =>
                Effect.gen(function* () {
                  if (!(yield* ours(tx))) return "lost" as const;
                  if ((yield* tx.get<number>(wakesKey)) !== wakes) return "again" as const;
                  yield* tx.delete([leaseKey]);
                  if (next === undefined) yield* tx.deleteTimer(name);
                  else yield* tx.setTimer(name, next);
                  return "done" as const;
                }),
              );
              if (done === "lost") return;
              if (done === "done") {
                if (next !== undefined) yield* later(partition, name, next);
                return;
              }
            }
          }).pipe(
            Effect.raceFirst(heartbeat),
            Effect.catchTag("LeaseLost", () =>
              Effect.logWarning(`Domain ${name} of ${partition} lost its lease; stopped`),
            ),
            // Stopped (the process is shutting down): hand any unfinished work
            // to whichever process polls next.
            Effect.onInterrupt(() =>
              transact(partition, (tx) =>
                Effect.gen(function* () {
                  if (!(yield* ours(tx))) return;
                  yield* tx.delete([leaseKey]);
                  if ((yield* tx.timer(name)) !== undefined) {
                    yield* tx.setTimer(name, yield* Clock.currentTimeMillis);
                  }
                }),
              ).pipe(Effect.ignoreCause),
            ),
          );
        });

      // At most one run per partition in this process: a kick during a run
      // makes it go again instead of starting a second one.
      const running = new Map<string, { again: boolean }>();
      const kick = (key: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          const current = running.get(key);
          if (current) {
            current.again = true;
            return Effect.void;
          }
          const state = { again: false };
          running.set(key, state);
          const loop: Effect.Effect<void> = Effect.suspend(() => {
            state.again = false;
            return runOnce(key).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`Domain ${name} of ${partitionOf(key)} failed`, cause),
              ),
              Effect.andThen(Effect.suspend(() => (state.again ? loop : Effect.void))),
            );
          });
          return background(loop.pipe(Effect.ensuring(Effect.sync(() => running.delete(key)))));
        });

      return { signal, kick };
    };

    /**
     * A durable, ordered queue of rows on a partition, staged in the same
     * transaction as the change that produced them and processed in order
     * after the commit. A row is deleted once its processing succeeds.
     */
    const queue = <Row>(
      scope: string,
      name: string,
      process: (row: Row) => Effect.Effect<void>,
    ) => {
      const prefix = `${name}:`;
      const seqKey = `${name}-seq`;
      const drainer = worker(scope, name, (key) =>
        Effect.gen(function* () {
          const partition = `${scope}/${key}`;
          while (true) {
            const rows = yield* read(partition, (r) => r.list<Row>({ prefix, limit: 100 }));
            if (rows.length === 0) return undefined;
            // Delete what was processed in one transaction, even when a row
            // fails part-way, so a retry starts at the failed row.
            const processed: Array<string> = [];
            const exit = yield* Effect.exit(
              Effect.forEach(
                rows,
                ([rowKey, row]) =>
                  process(row).pipe(Effect.andThen(Effect.sync(() => void processed.push(rowKey)))),
                { discard: true },
              ),
            );
            if (processed.length > 0) yield* transact(partition, (tx) => tx.delete(processed));
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
          }
        }),
      );
      return {
        /** Stage rows; call inside the transaction that commits their cause. */
        stage: (tx: Transaction, rows: ReadonlyArray<Row>) =>
          Effect.gen(function* () {
            if (rows.length === 0) return;
            const last = ((yield* tx.get<number>(seqKey)) ?? 0) + rows.length;
            const entries: Record<string, Json> = { [seqKey]: last };
            rows.forEach((row, index) => {
              entries[`${prefix}${pad(last - rows.length + index + 1)}`] = row;
            });
            yield* tx.put(entries);
            yield* drainer.signal(tx);
          }),
        kick: drainer.kick,
      };
    };

    // ------------------------------------------------------------ the platform

    const platform = Platform.of({
      aggregate: (aggregate, kit) =>
        Effect.gen(function* () {
          const scope = scopeOf("aggregate", aggregate.aggregateName);
          const partitionOf = (id: string) => `${scope}/${id}`;
          const outbox = queue<Delivery>(scope, "outbox", kit.deliver);
          const readMeta = (id: string) =>
            read(partitionOf(id), (r) =>
              r.get<{ state: Json | null; version: number }>("meta"),
            ).pipe(Effect.map((meta) => meta ?? { state: null, version: 0 }));
          const eventsAfter = (id: string, after: number) =>
            read(partitionOf(id), (r) =>
              r.list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}` }),
            ).pipe(Effect.map((rows) => rows.map(([, event]) => event)));
          const live = yield* watcher(partitionOf, readMeta, (meta) => meta.version);

          const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
            Effect.gen(function* () {
              const { sent, committed } = yield* transact(partitionOf(id), (tx) =>
                Effect.gen(function* () {
                  const duplicate = yield* tx.get<SendResult>(`receipt:${meta.commandId}`);
                  if (duplicate) return { sent: duplicate, committed: undefined };
                  const current = (yield* tx.get<{ state: Json | null; version: number }>(
                    "meta",
                  )) ?? { state: null, version: 0 };
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
                  if (result._tag === "Rejected") {
                    return { sent: result as SendResult, committed: undefined };
                  }
                  const sent: SendResult = {
                    _tag: "Accepted",
                    receipt: {
                      stream: `${kit.name}/${id}`,
                      version: result.version,
                      events: result.events.map((e) => e.event),
                      reply: result.reply,
                    },
                  };
                  const rows: Record<string, Json> = {
                    meta: { state: result.state, version: result.version },
                    [`receipt:${meta.commandId}`]: sent,
                  };
                  for (const event of result.events)
                    rows[`event:${pad(event.envelope.seq)}`] = event;
                  yield* tx.put(rows);
                  yield* outbox.stage(tx, result.deliveries);
                  return { sent, committed: result };
                }),
              );
              if (committed) {
                yield* notify(partitionOf(id));
                if (committed.deliveries.length > 0) yield* outbox.kick(id);
              }
              return sent;
            });

          handlers.set(scope, (id, name) => {
            if (name === "outbox") return outbox.kick(id);
            if (!name.startsWith("sched:")) return Effect.void;
            // A scheduled command: send it (sends dedupe by command id), then forget it.
            return Effect.gen(function* () {
              const job = yield* read(partitionOf(id), (r) =>
                r.get<{ readonly command: Json; readonly meta: Aggregate.SendMeta }>(name),
              );
              if (job) yield* send(id, job.command, job.meta);
              yield* transact(partitionOf(id), (tx) =>
                tx.delete([name]).pipe(Effect.andThen(tx.deleteTimer(name))),
              );
            });
          });

          return {
            send,
            schedule: (id, command, meta, due) =>
              Effect.gen(function* () {
                const at =
                  "at" in due ? due.at : (yield* Clock.currentTimeMillis) + due.afterMillis;
                const name = `sched:${meta.commandId}`;
                yield* transact(partitionOf(id), (tx) =>
                  tx.put({ [name]: { command, meta } }).pipe(Effect.andThen(tx.setTimer(name, at))),
                );
                yield* later(partitionOf(id), name, at);
              }),
            state: readMeta,
            events: (id) => eventsAfter(id, 0),
            changes: live.changes,
            tail: (id, after) =>
              live.tail(
                id,
                after,
                (cursor) => eventsAfter(id, cursor),
                (event) => event.envelope.seq,
              ),
            seed: (id, events) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const deliveries = yield* transact(partitionOf(id), (tx) =>
                  Effect.gen(function* () {
                    const current = (yield* tx.get<{ state: Json | null; version: number }>(
                      "meta",
                    )) ?? { state: null, version: 0 };
                    const result = kit.seed({
                      id,
                      state: current.state,
                      version: current.version,
                      events,
                      commandId: `seed:${id}:${current.version}`,
                      now,
                    });
                    const rows: Record<string, Json> = {
                      meta: { state: result.state, version: result.version },
                    };
                    for (const event of result.events) {
                      rows[`event:${pad(event.envelope.seq)}`] = event;
                    }
                    yield* tx.put(rows);
                    yield* outbox.stage(tx, result.deliveries);
                    return result.deliveries;
                  }),
                );
                yield* notify(partitionOf(id));
                if (deliveries.length > 0) yield* outbox.kick(id);
              }),
          };
        }),

      view: (view, kit) =>
        Effect.gen(function* () {
          const scope = scopeOf("view", view.viewName);
          const partitionOf = (key: string) => `${scope}/${key}`;
          const outbox = queue<Delivery>(scope, "outbox", kit.deliver);
          const readSnapshot = (key: string) =>
            read(partitionOf(key), (r) => r.get<ViewSnapshot>("snapshot")).pipe(
              Effect.map((snapshot) => snapshot ?? emptySnapshot),
            );
          const entriesAfter = (key: string, after: number) =>
            read(partitionOf(key), (r) =>
              r.list<ViewEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` }),
            ).pipe(Effect.map((rows) => rows.map(([, entry]) => entry)));
          const live = yield* watcher(partitionOf, readSnapshot, (snapshot) => snapshot.version);
          handlers.set(scope, (key, name) => (name === "outbox" ? outbox.kick(key) : Effect.void));
          return {
            receive: (key, deliveries) =>
              Effect.gen(function* () {
                const result = yield* transact(partitionOf(key), (tx) =>
                  Effect.gen(function* () {
                    const before = (yield* tx.get<ViewSnapshot>("snapshot")) ?? emptySnapshot;
                    const result = kit.apply(key, before, deliveries);
                    if (!result.changed) return undefined;
                    // The key's immutable input log: every delivery it applied, in order.
                    const accepted = deliveries.filter(
                      (d) => (before.checkpoints[d.source] ?? 0) < d.seq,
                    );
                    const inputs = (yield* tx.get<number>("in-seq")) ?? 0;
                    const rows: Record<string, Json> = {
                      "in-seq": inputs + accepted.length,
                      snapshot: result.snapshot,
                    };
                    accepted.forEach((delivery, index) => {
                      rows[`in:${pad(inputs + index + 1)}`] = delivery;
                    });
                    for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
                    yield* tx.put(rows);
                    yield* outbox.stage(tx, result.downstream);
                    return result;
                  }),
                ).pipe(kit.observe(key, deliveries));
                if (!result) return;
                yield* notify(partitionOf(key));
                if (result.downstream.length > 0) yield* outbox.kick(key);
              }),
            read: readSnapshot,
            changes: live.changes,
            list: (key) => entriesAfter(key, 0),
            tail: (key, after) =>
              live.tail(
                key,
                after,
                (cursor) => entriesAfter(key, cursor),
                (entry) => entry.seq,
              ),
          };
        }),

      policy: (policy, kit) =>
        Effect.sync(() => {
          const scope = scopeOf("policy", policy.policyName);
          const inbox = queue<Delivery>(scope, "inbox", kit.run);
          handlers.set(scope, (key, name) => (name === "inbox" ? inbox.kick(key) : Effect.void));
          return {
            receive: (delivery) =>
              Effect.gen(function* () {
                const seen = `seen:${delivery.source}:${delivery.seq}`;
                const accepted = yield* transact(`${scope}/${delivery.key}`, (tx) =>
                  Effect.gen(function* () {
                    if (yield* tx.get(seen)) return false;
                    yield* tx.put({ [seen]: true });
                    yield* inbox.stage(tx, [delivery]);
                    return true;
                  }),
                );
                if (accepted) yield* inbox.kick(delivery.key);
              }),
          };
        }),

      projection: (projection, kit) =>
        Effect.sync(() => {
          const scope = scopeOf("projection", projection.projectionName);
          const partitionOf = (key: string) => `${scope}/${key}`;
          const size = kit.options.batch?.size ?? 1;
          const waitMillis = kit.options.batch?.waitMillis ?? 0;
          const readMeta = (key: string) =>
            read(partitionOf(key), (r) => r.get<ProjectionMeta>("meta")).pipe(
              Effect.map((meta) => meta ?? emptyProjectionMeta),
            );
          // Hand the key's unprocessed inputs to the handler in order, in
          // batches; a short batch waits up to `waitMillis` to fill.
          const drainer = worker(scope, "drain", (key) =>
            Effect.gen(function* () {
              const partition = partitionOf(key);
              while (true) {
                const meta = yield* readMeta(key);
                if (meta.processed >= meta.accepted) return undefined;
                const run = (yield* read(partition, (r) =>
                  r.list<Accepted>({
                    prefix: "in:",
                    start: `in:${pad(meta.processed + 1)}`,
                    limit: size,
                  }),
                )).map(([, accepted]) => accepted);
                if (run.length === 0) return undefined;
                const now = yield* Clock.currentTimeMillis;
                if (run.length < size && waitMillis > 0 && now - run[0]!.at < waitMillis) {
                  return run[0]!.at + waitMillis;
                }
                yield* kit.run(key, run);
                yield* transact(partition, (tx) =>
                  Effect.gen(function* () {
                    const current = (yield* tx.get<ProjectionMeta>("meta")) ?? emptyProjectionMeta;
                    const handled: Record<string, number> = {};
                    for (const { delivery } of run) {
                      handled[delivery.source] = Math.max(
                        handled[delivery.source] ?? 0,
                        delivery.seq,
                      );
                    }
                    yield* tx.put({
                      meta: {
                        ...current,
                        processed: run[run.length - 1]!.position,
                        checkpoints: mergeCheckpoints(current.checkpoints, handled),
                      } satisfies ProjectionMeta,
                    });
                  }),
                );
              }
            }),
          );
          handlers.set(scope, (key, name) => (name === "drain" ? drainer.kick(key) : Effect.void));
          return {
            receive: (delivery) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis;
                const accepted = yield* transact(partitionOf(delivery.key), (tx) =>
                  Effect.gen(function* () {
                    const meta = (yield* tx.get<ProjectionMeta>("meta")) ?? emptyProjectionMeta;
                    if ((meta.intake[delivery.source] ?? 0) >= delivery.seq) return false;
                    const position = meta.accepted + 1;
                    yield* tx.put({
                      [`in:${pad(position)}`]: { position, delivery, at } satisfies Accepted,
                      meta: {
                        ...meta,
                        accepted: position,
                        intake: { ...meta.intake, [delivery.source]: delivery.seq },
                      } satisfies ProjectionMeta,
                    });
                    yield* drainer.signal(tx);
                    return true;
                  }),
                );
                if (accepted) yield* drainer.kick(delivery.key);
              }),
            checkpoints: (key) => readMeta(key).pipe(Effect.map((meta) => meta.checkpoints)),
          };
        }),

      stream: (stream, kit) =>
        Effect.gen(function* () {
          const scope = scopeOf("stream", stream.streamName);
          const partitionOf = (key: string) => `${scope}/${key}`;
          const readMeta = (key: string) =>
            read(partitionOf(key), (r) => r.get<StreamMeta>("meta")).pipe(
              Effect.map((meta) => meta ?? emptyStreamMeta),
            );
          const entriesAfter = (key: string, after: number) =>
            read(partitionOf(key), (r) =>
              r.list<StreamEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` }),
            ).pipe(Effect.map((rows) => rows.map(([, entry]) => entry)));
          const live = yield* watcher(partitionOf, readMeta, (meta) => meta.seq);
          return {
            append: (key, write) =>
              Effect.gen(function* () {
                const appended = yield* transact(partitionOf(key), (tx) =>
                  Effect.gen(function* () {
                    const meta = (yield* tx.get<StreamMeta>("meta")) ?? emptyStreamMeta;
                    if (!isAfter(write.origin, meta.origin)) return false;
                    const rows: Record<string, Json> = {};
                    write.events.forEach((event, index) => {
                      const seq = meta.seq + index + 1;
                      rows[`entry:${pad(seq)}`] = {
                        seq,
                        event,
                        envelope: {
                          id: key,
                          stream: `${kit.name}/${key}`,
                          seq,
                          at: write.at,
                          commandId: write.commandId,
                        },
                      } satisfies StreamEntry;
                    });
                    rows.meta = {
                      seq: meta.seq + write.events.length,
                      origin: write.origin,
                      checkpoints: mergeCheckpoints(meta.checkpoints, {
                        [write.source]: write.sourceSeq,
                      }),
                    } satisfies StreamMeta;
                    yield* tx.put(rows);
                    return write.events.length > 0;
                  }),
                );
                if (appended) yield* notify(partitionOf(key));
              }),
            advance: (key, checkpoints) =>
              transact(partitionOf(key), (tx) =>
                Effect.gen(function* () {
                  const meta = (yield* tx.get<StreamMeta>("meta")) ?? emptyStreamMeta;
                  yield* tx.put({
                    meta: {
                      ...meta,
                      checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
                    } satisfies StreamMeta,
                  });
                }),
              ),
            read: readMeta,
            changes: live.changes,
            list: (key) => entriesAfter(key, 0),
            tail: (key, after) =>
              live.tail(
                key,
                after,
                (cursor) => entriesAfter(key, cursor),
                (entry) => entry.seq,
              ),
          };
        }),
    });

    // ------------------------------------------------------------ workflows

    /**
     * Sagas run here as Effect workflows, each run a partition holding its
     * journal. A run replays the workflow from the top: finished activities
     * return their stored results, and the first unfinished one runs and is
     * stored. A run waiting on a clock or deferred that isn't ready suspends;
     * the clock firing or the deferred completing runs it again.
     */
    const registrations = new Map<
      string,
      { readonly workflow: AnyWorkflow; readonly execute: Execute; readonly runner: Runner }
    >();
    interface Runner {
      readonly signal: (tx: Transaction) => Effect.Effect<void, StorageError>;
      readonly kick: (executionId: string) => Effect.Effect<void>;
    }
    const workflowPartition = (workflowName: string, executionId: string) =>
      `${scopeOf("workflow", workflowName)}/${executionId}`;
    const registration = (workflowName: string) =>
      Effect.suspend(() => {
        const found = registrations.get(workflowName);
        return found
          ? Effect.succeed(found)
          : Effect.die(new Error(`Workflow ${workflowName} is not registered`));
      });
    const readExecution = (partition: string) =>
      read(partition, (r) => r.get<ExecutionRow>("execution"));
    /** Record a change on a run, then run it again. */
    const wake = (
      workflowName: string,
      executionId: string,
      change: (tx: Transaction) => Effect.Effect<boolean, StorageError> = () =>
        Effect.succeed(true),
    ) =>
      Effect.gen(function* () {
        const { runner } = yield* registration(workflowName);
        const changed = yield* transact(workflowPartition(workflowName, executionId), (tx) =>
          change(tx).pipe(Effect.tap((changed) => (changed ? runner.signal(tx) : Effect.void))),
        );
        if (changed) yield* runner.kick(executionId);
      });
    /** Complete a deferred of a run (once), and run it again. */
    const complete = (
      workflowName: string,
      executionId: string,
      deferredName: string,
      exit: string,
    ) =>
      wake(workflowName, executionId, (tx) =>
        Effect.gen(function* () {
          if ((yield* tx.get(`deferred:${deferredName}`)) !== undefined) return false;
          yield* tx.put({ [`deferred:${deferredName}`]: exit });
          return true;
        }),
      );

    const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
      register: (workflow, execute) =>
        Effect.sync(() => {
          if (registrations.has(workflow._tag)) return;
          const scope = scopeOf("workflow", workflow._tag);
          const runner = worker(scope, "run", (executionId) =>
            Effect.gen(function* () {
              const partition = `${scope}/${executionId}`;
              const row = yield* readExecution(partition);
              if (row === undefined) return undefined;
              if (row.result !== null) {
                // Finished. Waking its parent may have failed after the result
                // committed, so wake it again (a parent replay is idempotent).
                if (row.parent !== null) {
                  yield* wake(row.parent.workflowName, row.parent.executionId);
                }
                return undefined;
              }
              const typed = workflow as AnyWorkflow;
              const payload = yield* Schema.decodeEffect(payloadCodec(typed))(row.payload).pipe(
                Effect.orDie,
              );
              const instance = WorkflowEngine.WorkflowInstance.initial(typed, executionId);
              const result = yield* (execute as Execute)(payload as object, executionId).pipe(
                // An interrupted run replays to where it waits, then is
                // interrupted there, which fails it and runs its compensations.
                Effect.onExit(() => {
                  if (!row.interrupted) return Effect.void;
                  instance.interrupted = true;
                  instance.suspended = false;
                  return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)));
                }),
                Workflow.intoResult,
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
                    Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
                  ),
                ),
              );
              // Suspended: a clock or a completed deferred wakes it again.
              if (result._tag === "Suspended") return undefined;
              const encoded = yield* encodeResult(typed, result.exit);
              yield* transact(partition, (tx) =>
                Effect.gen(function* () {
                  const current = yield* tx.get<ExecutionRow>("execution");
                  if (current && current.result === null) {
                    yield* tx.put({ execution: { ...current, result: encoded } });
                  }
                }),
              );
              // A child run finished: its parent replays and reads the child's result.
              if (row.parent !== null) {
                yield* wake(row.parent.workflowName, row.parent.executionId);
              }
              return undefined;
            }),
          );
          registrations.set(workflow._tag, {
            workflow: workflow as AnyWorkflow,
            execute: execute as Execute,
            runner,
          });
          handlers.set(scope, (executionId, name) => {
            if (name === "run") return runner.kick(executionId);
            if (!name.startsWith("clock:")) return Effect.void;
            // A clock is due: complete its deferred.
            return Effect.gen(function* () {
              const partition = `${scope}/${executionId}`;
              const clock = yield* read(partition, (r) =>
                r.get<{ readonly deferred: string }>(name),
              );
              if (clock) {
                yield* complete(
                  workflow._tag,
                  executionId,
                  clock.deferred,
                  yield* encodeExit(Exit.void),
                );
              }
              yield* transact(partition, (tx) => tx.deleteTimer(name));
            });
          });
        }),

      execute: (workflow, options) =>
        Effect.gen(function* () {
          const payload = yield* Schema.encodeEffect(payloadCodec(workflow as AnyWorkflow))(
            options.payload,
          ).pipe(Effect.orDie);
          const { runner } = yield* registration(workflow._tag);
          const partition = workflowPartition(workflow._tag, options.executionId);
          const { result, created } = yield* transact(partition, (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx.get<ExecutionRow>("execution");
              if (existing) return { result: existing.result, created: false };
              yield* tx.put({
                execution: {
                  executionId: options.executionId,
                  payload: payload as Json,
                  parent: options.parent
                    ? {
                        workflowName: options.parent.workflow._tag,
                        executionId: options.parent.executionId,
                      }
                    : null,
                  interrupted: false,
                  result: null,
                } satisfies ExecutionRow,
              });
              yield* runner.signal(tx);
              return { result: null, created: true };
            }),
          );
          if (created) yield* runner.kick(options.executionId);
          if (options.discard) return undefined;
          return result === null
            ? new Workflow.Suspended({})
            : yield* decodeResult(workflow as AnyWorkflow, result);
        }) as Effect.Effect<any>,

      poll: (workflow, executionId) =>
        Effect.gen(function* () {
          const row = yield* readExecution(workflowPartition(workflow._tag, executionId));
          if (row === undefined) return Option.none();
          if (row.result === null) return Option.some(new Workflow.Suspended({}));
          return Option.some(yield* decodeResult(workflow as AnyWorkflow, row.result));
        }),

      // The next run replays with the run marked interrupted, which fails the
      // workflow and runs its compensations.
      interrupt: (workflow, executionId) =>
        wake(workflow._tag, executionId, (tx) =>
          Effect.gen(function* () {
            const row = yield* tx.get<ExecutionRow>("execution");
            if (row === undefined || row.result !== null) return false;
            yield* tx.put({ execution: { ...row, interrupted: true } });
            return true;
          }),
        ),

      // Stop without running compensations.
      interruptUnsafe: (workflow, executionId) =>
        Effect.gen(function* () {
          const result = yield* encodeResult(workflow as AnyWorkflow, Exit.interrupt());
          yield* transact(workflowPartition(workflow._tag, executionId), (tx) =>
            Effect.gen(function* () {
              const row = yield* tx.get<ExecutionRow>("execution");
              if (row === undefined || row.result !== null) return;
              yield* tx.put({ execution: { ...row, interrupted: true, result } });
              yield* tx.deleteTimer("run");
            }),
          );
        }),

      resume: (workflow, executionId) => wake(workflow._tag, executionId),

      // An activity's result is stored the first time it completes and
      // replayed on every run after that.
      activityExecute: (activity, attempt) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const partition = workflowPartition(instance.workflow._tag, instance.executionId);
          const key = `activity:${activity.name}/${attempt}`;
          const stored = yield* read(partition, (r) => r.get<string>(key));
          if (stored !== undefined) {
            return new Workflow.Complete({ exit: yield* decodeExit(stored) });
          }
          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          const result = yield* activity.executeEncoded.pipe(
            Workflow.intoResult,
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEngine.WorkflowInstance, activityInstance),
                Layer.succeed(
                  CurrentActivity,
                  makeCurrentActivity(instance.workflow._tag, instance.executionId, activity.name),
                ),
              ),
            ),
          );
          if (result._tag === "Complete") {
            const exit = yield* encodeExit(result.exit);
            yield* transact(partition, (tx) => tx.put({ [key]: exit }));
          }
          return result;
        }),

      deferredResult: (deferred) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const stored = yield* read(
            workflowPartition(instance.workflow._tag, instance.executionId),
            (r) => r.get<string>(`deferred:${deferred.name}`),
          );
          if (stored === undefined) return Option.none();
          return Option.some(yield* decodeExit(stored));
        }),

      deferredDone: (options) =>
        Effect.gen(function* () {
          const exit = yield* encodeExit(options.exit);
          yield* complete(options.workflowName, options.executionId, options.deferredName, exit);
        }),

      // A clock keeps the due time it was first given, however many times the
      // run replays past `DurableClock.sleep`.
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const partition = workflowPartition(workflow._tag, options.executionId);
          const name = `clock:${options.clock.name}`;
          // A replay past a clock already set (or already fired) changes nothing.
          const known = yield* read(partition, (r) =>
            Effect.all({
              clock: r.get(name),
              timer: r.timer(name),
              fired: r.get(`deferred:${options.clock.deferred.name}`),
            }),
          );
          if (
            known.fired !== undefined ||
            (known.clock !== undefined && known.timer !== undefined)
          ) {
            return;
          }
          const due = yield* transact(partition, (tx) =>
            Effect.gen(function* () {
              const clock = yield* tx.get<{ readonly deferred: string; readonly due: number }>(
                name,
              );
              const due = clock?.due ?? now + Duration.toMillis(options.clock.duration);
              if (!clock) yield* tx.put({ [name]: { deferred: options.clock.deferred.name, due } });
              if ((yield* tx.get(`deferred:${options.clock.deferred.name}`)) !== undefined) {
                return undefined;
              }
              if ((yield* tx.timer(name)) === undefined) yield* tx.setTimer(name, due);
              return due;
            }),
          );
          if (due !== undefined) yield* later(partition, name, due);
        }),
    });

    return { platform, engine };
  });

/**
 * Host a domain model on any {@link Storage}, with a durable workflow engine
 * for its sagas.
 */
export const layer = (
  options: Options = {},
): Layer.Layer<Platform | WorkflowEngine.WorkflowEngine, never, Storage> =>
  Layer.effectContext(
    Effect.map(make(options), ({ platform, engine }) =>
      Context.make(Platform, platform).pipe(Context.add(WorkflowEngine.WorkflowEngine, engine)),
    ),
  );

/**
 * Host a domain model on any storage you provide: `Domain.SqlStorage` for
 * Postgres, MySQL or SQLite, or your own `Domain.Storage`. Aggregates, views,
 * policies, projections, streams and sagas all keep their state there, so the
 * model survives restarts, and any number of processes can host it on one
 * store.
 *
 * Commands to one aggregate instance run one at a time, and their events,
 * state and outbox commit together. Deliveries are at least once and in order
 * per source; a process that dies mid-delivery leaves its work to a durable
 * timer that any process picks up. Live reads are streamed responses,
 * updated at once by local commits and by polling for others.
 *
 * It runs background work (timers, deliveries), so host it in a long-running
 * process: a server or container. On Cloudflare, use
 * `DomainCloudflare.DurableObjects`.
 *
 * ### Hosting on a database
 * **Example:** A model on Postgres
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.StoragePlatform),
 *   Layer.provide(Domain.SqlStorage),
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
 * );
 * ```
 *
 * **Example:** A model on a local SQLite file
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { LibsqlClient } from "@effect/sql-libsql";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.StoragePlatform),
 *   Layer.provide(Domain.SqlStorage),
 *   Layer.provide(LibsqlClient.layer({ url: "file:bank.db" })),
 * );
 * ```
 *
 * ### Tuning polling
 * **Example:** Poll for due timers every 5 seconds
 * ```typescript
 * import * as StoragePlatform from "@alchemy.run/domain/StoragePlatform";
 *
 * const Platform = StoragePlatform.layer({ pollMillis: 5_000 });
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const StoragePlatform: Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine,
  never,
  Storage
> = layer();
