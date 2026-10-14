import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { WorkflowEngine } from "effect/workflow";
import type * as Aggregate from "./Aggregate.ts";
import * as InMemoryWorkflows from "./InMemoryWorkflows.ts";
import {
  type Accepted,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  Platform,
  type Json,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamMeta,
  type ViewEntry,
  type ViewSnapshot,
} from "./Platform.ts";

/**
 * Options for {@link make}.
 */
export interface Options {
  /**
   * When `true`, deliveries queue until {@link Control.drain} is called and
   * policy runs are tracked so a caller can wait for quiescence. Used by the
   * story runner. Defaults to `false` (deliver in the background).
   */
  readonly manual?: boolean;
  /** Clock used to time-stamp commands. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Control surface of an in-memory platform.
 */
export interface Control {
  /**
   * Send due scheduled commands, then deliver every queued delivery (and
   * those it produces) until the queue is empty.
   */
  readonly drain: Effect.Effect<void>;
  /** `true` when nothing is queued and every running policy is suspended. */
  readonly idle: Effect.Effect<boolean>;
  /** Mark the current policy run as suspended while `effect` runs (story external systems). */
  readonly suspended: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Defects raised by policy and projection runs. */
  readonly failures: ReadonlyArray<unknown>;
  /** Saga runs that ended with a defect, in the order they died. */
  readonly deaths: ReadonlyArray<{
    readonly saga: string;
    readonly executionId: string;
    readonly defect: unknown;
  }>;
}

/**
 * Build an in-memory platform and its control surface.
 */
export const make = (
  options: Options = {},
): {
  readonly layer: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine>;
  readonly control: Control;
} => {
  const now = options.now ?? (() => Date.now());
  // Deliveries and saga runs, in the order they were queued.
  const pending: Array<Effect.Effect<void>> = [];
  let draining = false;
  let running = 0;
  let suspended = 0;
  const failures: Array<unknown> = [];
  const deaths: Array<{ saga: string; executionId: string; defect: unknown }> = [];
  // Scheduled commands by `aggregate/id/commandId`, so rescheduling replaces.
  const timers = new Map<string, { readonly at: number; readonly fire: Effect.Effect<void> }>();

  /** Send every scheduled command that is due on the platform's clock. */
  const fireDue: Effect.Effect<void> = Effect.suspend(() => {
    const due = [...timers].filter(([, timer]) => timer.at <= now());
    for (const [key] of due) timers.delete(key);
    return Effect.forEach(due, ([, timer]) => timer.fire, { discard: true });
  });

  const deliverAll: Effect.Effect<void> = Effect.suspend(function loop(): Effect.Effect<void> {
    const next = pending.shift();
    if (!next) {
      draining = false;
      return Effect.void;
    }
    draining = true;
    return next.pipe(Effect.flatMap(loop));
  });

  const drain: Effect.Effect<void> = fireDue.pipe(Effect.andThen(deliverAll));

  const enqueueWork = (work: ReadonlyArray<Effect.Effect<void>>) =>
    Effect.suspend(() => {
      pending.push(...work);
      if (options.manual || draining || pending.length === 0) return Effect.void;
      draining = true;
      return Effect.forkDetach(drain).pipe(Effect.asVoid);
    });

  const enqueue = (
    deliveries: ReadonlyArray<Delivery>,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => enqueueWork(deliveries.map((delivery) => deliver(delivery)));

  /** Fire `fire` at `at`: from `drain` as a story's clock moves, otherwise in real time. */
  const timer = (key: string, at: number, fire: Effect.Effect<void>) =>
    Effect.suspend(() => {
      timers.set(key, { at, fire });
      if (options.manual) return Effect.void;
      return Effect.forkDetach(
        Effect.sleep(Math.max(0, at - now())).pipe(Effect.andThen(fireDue)),
      ).pipe(Effect.asVoid);
    });

  const workflows = InMemoryWorkflows.make({
    now,
    // A run is forked like a policy run, so one waiting on an external system
    // doesn't hold up the queue.
    enqueue: (run) =>
      enqueueWork([
        Effect.suspend(() => {
          running++;
          return Effect.forkDetach(run.pipe(Effect.ensuring(Effect.sync(() => running--)))).pipe(
            Effect.asVoid,
          );
        }),
      ]),
    timer,
    failed: (cause) => void failures.push(cause),
    died: (saga, executionId, defect) => void deaths.push({ saga, executionId, defect }),
  });

  const control: Control = {
    drain,
    idle: Effect.sync(() => pending.length === 0 && !draining && running === suspended),
    suspended: (effect) =>
      Effect.suspend(() => {
        suspended++;
        return effect.pipe(Effect.ensuring(Effect.sync(() => suspended--)));
      }),
    failures,
    deaths,
  };

  const platform = Platform.of({
    aggregate: (_aggregate, kit) =>
      Effect.sync(() => {
        const instances = new Map<
          string,
          {
            state: Json | null;
            version: number;
            readonly receipts: Map<string, SendResult>;
            readonly events: Array<StoredEvent>;
          }
        >();
        const lock = Semaphore.makeUnsafe(1);
        // The latest version of each instance that anyone watches.
        const versions = new Map<string, SubscriptionRef.SubscriptionRef<number>>();
        const versionOf = (id: string) =>
          Effect.suspend(() => {
            const found = versions.get(id);
            if (found) return Effect.succeed(found);
            return SubscriptionRef.make(instance(id).version).pipe(
              Effect.tap((created) => Effect.sync(() => versions.set(id, created))),
            );
          });
        const announce = (id: string) =>
          Effect.suspend(() => {
            const ref = versions.get(id);
            return ref ? SubscriptionRef.set(ref, instance(id).version) : Effect.void;
          });
        const instance = (id: string) => {
          let found = instances.get(id);
          if (!found)
            instances.set(
              id,
              (found = { state: null, version: 0, receipts: new Map(), events: [] }),
            );
          return found;
        };
        const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const current = instance(id);
              const duplicate = current.receipts.get(meta.commandId);
              if (duplicate) return duplicate;
              const result = kit.handle({
                id,
                state: current.state,
                version: current.version,
                command,
                commandId: meta.commandId,
                context: meta.context,
                now: now(),
              });
              if (result._tag === "Rejected") return result satisfies SendResult;
              current.state = result.state;
              current.version = result.version;
              current.events.push(...result.events);
              const sent: SendResult = {
                _tag: "Accepted",
                receipt: {
                  stream: `${kit.name}/${id}`,
                  version: result.version,
                  events: result.events.map((e) => e.event),
                  reply: result.reply,
                },
              };
              current.receipts.set(meta.commandId, sent);
              yield* announce(id);
              yield* enqueue(result.deliveries, kit.deliver);
              return sent;
            }),
          );
        return {
          send,
          schedule: (id, command, meta, due) =>
            Effect.suspend(() => {
              const at = "at" in due ? due.at : now() + due.afterMillis;
              return timer(
                `${kit.name}/${id}/${meta.commandId}`,
                at,
                send(id, command, meta).pipe(Effect.asVoid),
              );
            }),
          state: (id) =>
            Effect.sync(() => ({ state: instance(id).state, version: instance(id).version })),
          events: (id) => Effect.sync(() => [...instance(id).events]),
          changes: (id) =>
            Stream.unwrap(
              versionOf(id).pipe(
                Effect.map((ref) =>
                  SubscriptionRef.changes(ref).pipe(
                    Stream.map(() => ({
                      state: instance(id).state,
                      version: instance(id).version,
                    })),
                  ),
                ),
              ),
            ),
          tail: (id, after) =>
            Stream.unwrap(
              versionOf(id).pipe(
                Effect.map((ref) => {
                  let last = after;
                  return SubscriptionRef.changes(ref).pipe(
                    Stream.flatMap(() => {
                      const fresh = instance(id).events.filter((e) => e.envelope.seq > last);
                      if (fresh.length > 0) last = fresh[fresh.length - 1]!.envelope.seq;
                      return Stream.fromIterable(fresh);
                    }),
                  );
                }),
              ),
            ),
          seed: (id, events) =>
            lock.withPermits(1)(
              Effect.suspend(() => {
                const current = instance(id);
                const result = kit.seed({
                  id,
                  state: current.state,
                  version: current.version,
                  events,
                  commandId: `seed:${id}:${current.version}`,
                  now: now(),
                });
                current.state = result.state;
                current.version = result.version;
                current.events.push(...result.events);
                return announce(id).pipe(Effect.andThen(enqueue(result.deliveries, kit.deliver)));
              }),
            ),
        };
      }),

    view: (_view, kit) =>
      Effect.sync(() => {
        const keys = new Map<
          string,
          {
            readonly snapshot: SubscriptionRef.SubscriptionRef<ViewSnapshot>;
            readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyArray<ViewEntry>>;
            /** The key's immutable input log: every delivery it applied, in order. */
            readonly inputs: Array<Delivery>;
          }
        >();
        const lock = Semaphore.makeUnsafe(1);
        const get = (key: string) =>
          Effect.suspend(() => {
            const found = keys.get(key);
            if (found) return Effect.succeed(found);
            return Effect.all({
              snapshot: SubscriptionRef.make(emptySnapshot),
              entries: SubscriptionRef.make<ReadonlyArray<ViewEntry>>([]),
            }).pipe(
              Effect.map((created) => ({ ...created, inputs: [] as Array<Delivery> })),
              Effect.tap((created) => Effect.sync(() => keys.set(key, created))),
            );
          });
        return {
          receive: (key, deliveries) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* get(key);
                const result = kit.apply(
                  key,
                  yield* SubscriptionRef.get(current.snapshot),
                  deliveries,
                );
                if (!result.changed) return;
                const before = yield* SubscriptionRef.get(current.snapshot);
                current.inputs.push(
                  ...deliveries.filter((d) => (before.checkpoints[d.source] ?? 0) < d.seq),
                );
                if (result.entries.length > 0) {
                  yield* SubscriptionRef.update(current.entries, (entries) => [
                    ...entries,
                    ...result.entries,
                  ]);
                }
                yield* SubscriptionRef.set(current.snapshot, result.snapshot);
                yield* enqueue(result.downstream, kit.deliver);
              }),
            ),
          read: (key) =>
            get(key).pipe(Effect.flatMap((current) => SubscriptionRef.get(current.snapshot))),
          changes: (key) =>
            Stream.unwrap(
              get(key).pipe(Effect.map((current) => SubscriptionRef.changes(current.snapshot))),
            ),
          list: (key) =>
            get(key).pipe(Effect.flatMap((current) => SubscriptionRef.get(current.entries))),
          tail: (key, after) =>
            Stream.unwrap(
              get(key).pipe(
                Effect.map((current) => {
                  let last = after;
                  return SubscriptionRef.changes(current.entries).pipe(
                    Stream.flatMap((entries) => {
                      const fresh = entries.filter((entry) => entry.seq > last);
                      if (fresh.length > 0) last = fresh[fresh.length - 1]!.seq;
                      return Stream.fromIterable(fresh);
                    }),
                  );
                }),
              ),
            ),
        };
      }),

    projection: (_projection, kit) =>
      Effect.sync(() => {
        interface Partition {
          readonly log: Array<Accepted>;
          processed: number;
          readonly intake: Record<string, number>;
          readonly checkpoints: Record<string, number>;
          timer: boolean;
          readonly lock: Semaphore.Semaphore;
        }
        const partitions = new Map<string, Partition>();
        const partition = (key: string) => {
          let found = partitions.get(key);
          if (!found) {
            partitions.set(
              key,
              (found = {
                log: [],
                processed: 0,
                intake: {},
                checkpoints: {},
                timer: false,
                lock: Semaphore.makeUnsafe(1),
              }),
            );
          }
          return found;
        };
        const batch = kit.options.batch;
        /** Handle the key's unprocessed inputs in order, in batches; leave a short batch to fill. */
        const process = (key: string, flush: boolean): Effect.Effect<void> =>
          Effect.suspend(() => {
            const p = partition(key);
            return p.lock.withPermits(1)(
              Effect.gen(function* () {
                while (p.processed < p.log.length) {
                  const pending = p.log.length - p.processed;
                  const size = batch?.size ?? 1;
                  const oldest = p.log[p.processed]!;
                  if (
                    !flush &&
                    !options.manual &&
                    pending < size &&
                    batch &&
                    now() - oldest.at < batch.waitMillis
                  ) {
                    if (!p.timer) {
                      p.timer = true;
                      running++;
                      yield* Effect.forkDetach(
                        Effect.sleep(batch.waitMillis - (now() - oldest.at)).pipe(
                          Effect.andThen(
                            Effect.sync(() => {
                              p.timer = false;
                            }),
                          ),
                          Effect.andThen(process(key, true)),
                          Effect.ensuring(Effect.sync(() => running--)),
                        ),
                      );
                    }
                    return;
                  }
                  const run = p.log.slice(p.processed, p.processed + size);
                  yield* kit.run(key, run);
                  p.processed += run.length;
                  for (const { delivery } of run) {
                    p.checkpoints[delivery.source] = Math.max(
                      p.checkpoints[delivery.source] ?? 0,
                      delivery.seq,
                    );
                  }
                }
              }),
            );
          });
        return {
          receive: (delivery) =>
            Effect.suspend(() => {
              const p = partition(delivery.key);
              if ((p.intake[delivery.source] ?? 0) >= delivery.seq) return Effect.void;
              p.intake[delivery.source] = delivery.seq;
              p.log.push({ position: p.log.length + 1, delivery, at: now() });
              running++;
              return Effect.forkDetach(
                process(delivery.key, false).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => failures.push(cause)).pipe(
                      Effect.andThen(Effect.logError(`projection ${kit.name} failed`, cause)),
                    ),
                  ),
                  Effect.ensuring(Effect.sync(() => running--)),
                ),
              ).pipe(Effect.asVoid);
            }),
          checkpoints: (key) => Effect.sync(() => ({ ...partition(key).checkpoints })),
        };
      }),

    stream: (_stream, _kit) =>
      Effect.sync(() => {
        const keys = new Map<
          string,
          {
            readonly meta: SubscriptionRef.SubscriptionRef<StreamMeta>;
            readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyArray<StreamEntry>>;
          }
        >();
        const lock = Semaphore.makeUnsafe(1);
        const get = (key: string) =>
          Effect.suspend(() => {
            const found = keys.get(key);
            if (found) return Effect.succeed(found);
            return Effect.all({
              meta: SubscriptionRef.make(emptyStreamMeta),
              entries: SubscriptionRef.make<ReadonlyArray<StreamEntry>>([]),
            }).pipe(Effect.tap((created) => Effect.sync(() => keys.set(key, created))));
          });
        return {
          append: (key, write) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* get(key);
                const meta = yield* SubscriptionRef.get(current.meta);
                if (!isAfter(write.origin, meta.origin)) return;
                const added: Array<StreamEntry> = write.events.map((event, index) => {
                  const seq = meta.seq + index + 1;
                  return {
                    seq,
                    event,
                    envelope: {
                      id: key,
                      stream: `${_kit.name}/${key}`,
                      seq,
                      at: write.at,
                      commandId: write.commandId,
                    },
                  };
                });
                yield* SubscriptionRef.update(current.entries, (entries) => [...entries, ...added]);
                yield* SubscriptionRef.set(current.meta, {
                  seq: meta.seq + added.length,
                  origin: write.origin,
                  checkpoints: {
                    ...meta.checkpoints,
                    [write.source]: Math.max(meta.checkpoints[write.source] ?? 0, write.sourceSeq),
                  },
                });
              }),
            ),
          advance: (key, checkpoints) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* get(key);
                yield* SubscriptionRef.update(current.meta, (meta) => ({
                  ...meta,
                  checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
                }));
              }),
            ),
          read: (key) =>
            get(key).pipe(Effect.flatMap((current) => SubscriptionRef.get(current.meta))),
          changes: (key) =>
            Stream.unwrap(
              get(key).pipe(Effect.map((current) => SubscriptionRef.changes(current.meta))),
            ),
          list: (key) =>
            get(key).pipe(Effect.flatMap((current) => SubscriptionRef.get(current.entries))),
          tail: (key, after) =>
            Stream.unwrap(
              get(key).pipe(
                Effect.map((current) => {
                  let last = after;
                  return SubscriptionRef.changes(current.entries).pipe(
                    Stream.flatMap((entries) => {
                      const fresh = entries.filter((entry) => entry.seq > last);
                      if (fresh.length > 0) last = fresh[fresh.length - 1]!.seq;
                      return Stream.fromIterable(fresh);
                    }),
                  );
                }),
              ),
            ),
        };
      }),

    policy: (_policy, kit) =>
      Effect.sync(() => {
        const locks = new Map<string, Semaphore.Semaphore>();
        const lockFor = (key: string) => {
          let found = locks.get(key);
          if (!found) locks.set(key, (found = Semaphore.makeUnsafe(1)));
          return found;
        };
        return {
          receive: (delivery) =>
            Effect.suspend(() => {
              running++;
              return Effect.forkDetach(
                lockFor(delivery.key)
                  .withPermits(1)(kit.run(delivery))
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() => failures.push(cause)).pipe(
                        Effect.andThen(Effect.logError(`policy ${kit.name} failed`, cause)),
                      ),
                    ),
                    Effect.ensuring(Effect.sync(() => running--)),
                  ),
              ).pipe(Effect.asVoid);
            }),
        };
      }),
  });

  return {
    layer: Layer.mergeAll(
      Layer.succeed(Platform, platform),
      Layer.succeed(WorkflowEngine.WorkflowEngine, workflows),
    ),
    control,
  };
};

/**
 * Host a domain model in the current process: aggregates, views and policies,
 * with nothing to deploy. Use it in tests and single-process apps; swap it
 * for `DomainCloudflare.DurableObjects` and nothing else changes.
 *
 * ### Hosting in memory
 * **Example:** A model with its policies
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * export const BankInMemory = Bank.layer(BankPolicies).pipe(Layer.provide(Domain.InMemory));
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const InMemory: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine> = Layer.suspend(
  () => make().layer,
);

/** Is a stream write's origin after the last one applied? @internal */
export const isAfter = (
  origin: readonly [number, number],
  last: readonly [number, number],
): boolean => origin[0] > last[0] || (origin[0] === last[0] && origin[1] > last[1]);

/** The later of two sets of per-source checkpoints. @internal */
export const mergeCheckpoints = (
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> => {
  const out: Record<string, number> = { ...a };
  for (const [source, seq] of Object.entries(b)) out[source] = Math.max(out[source] ?? 0, seq);
  return out;
};
