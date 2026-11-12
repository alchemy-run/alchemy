import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { WorkflowEngine } from "effect/workflow";
import type * as Aggregate from "./Aggregate.ts";
import { AlreadyCancelled, AlreadyExecuted, NotScheduled } from "./Aggregate.ts";
import * as Backfill from "./Backfill.ts";
import { type Routed, targetId } from "./CatchUp.ts";
import * as InMemoryWorkflows from "./InMemoryWorkflows.ts";
import {
  type Accepted,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  hostedModels,
  inRange,
  Platform,
  type Json,
  type ModelHost,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamMeta,
  type ViewEntry,
  type ViewSnapshot,
} from "./Platform.ts";
import { serveSocket } from "./Watch.ts";

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
  /**
   * With `manual`: pick which ready writer (a policy delivery, a saga run or a
   * saga's next step) runs next, by its index in `ready`. Called only when
   * more than one is ready. Defaults to the first, in the order they were queued.
   */
  readonly choose?: (ready: ReadonlyArray<string>) => number;
  /**
   * With `manual`: called after each queued item has run (until every run it
   * started is finished or waiting), with the streams it committed to.
   */
  readonly ran?: (label: string, wrote: ReadonlyArray<string>) => void;
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
  /**
   * Mark the current run as waiting while `effect` runs: on a story's
   * external system, a lock, or its turn to run. With `manual`, `drain` runs
   * one queued item at a time, until every run is finished or waiting.
   */
  readonly suspended: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Defects raised by policy and projection runs. */
  readonly failures: ReadonlyArray<unknown>;
  /** Saga runs that ended with a defect, in the order they died. */
  readonly deaths: ReadonlyArray<{
    readonly saga: string;
    readonly executionId: string;
    readonly defect: unknown;
  }>;
  /**
   * Every event a command committed (seeded events excluded), in commit
   * order: its aggregate, instance id, and position in the instance's
   * events, from 0.
   */
  readonly commits: ReadonlyArray<{
    readonly aggregate: string;
    readonly id: string;
    readonly index: number;
  }>;
}

/** A queued item: what it runs, a name for reports, and its lane (writers only). */
interface Work {
  readonly run: Effect.Effect<void>;
  readonly label: string;
  /** Items in one lane run in queue order; reads have none and run first. */
  readonly lane: string | undefined;
}

/** A scheduled command's latest arming: the id it commits with, when it is due, and whether it was cancelled. */
interface Armed {
  readonly commandId: string;
  readonly at: number;
  readonly cancelled: boolean;
}

/** A scheduled command: when it is due, and how to send it. */
interface Timer {
  readonly at: number;
  readonly fire: Effect.Effect<void>;
}

/** A function that builds each value once per argument. */
const memo = <A>(make: (key: string) => A) => {
  const made = new Map<string, A>();
  return (key: string): A => {
    let found = made.get(key);
    if (found === undefined) made.set(key, (found = make(key)));
    return found;
  };
};

/**
 * Build an in-memory platform and its control surface.
 */
export const make = (
  options: Options = {},
): {
  readonly layer: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom>;
  readonly control: Control;
} => {
  const now = options.now ?? (() => Date.now());
  // Deliveries and saga runs, in the order they were queued.
  const pending: Array<Work> = [];
  let draining = false;
  // Forked runs, and how many of them are waiting (on an external call, a
  // lock, or their turn). Every change wakes `quiet`.
  let running = 0;
  let suspended = 0;
  let changed = Deferred.makeUnsafe<void>();
  const notify = () => {
    const was = changed;
    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(was, Effect.void);
  };
  const started = () => {
    running++;
    notify();
  };
  const stopped = Effect.sync(() => {
    running--;
    notify();
  });
  const waiting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      suspended++;
      notify();
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            suspended--;
            notify();
          }),
        ),
      );
    });
  /** Run `effect` holding `lock`, counted as waiting while another run holds it. */
  const exclusively =
    (lock: Semaphore.Semaphore) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquire(lock),
        () => effect,
        () => lock.release(1),
      );
  /** Take `lock`, counted as waiting only when it is held. */
  const acquire = (lock: Semaphore.Semaphore): Effect.Effect<void> =>
    lock
      .takeIfAvailable(1)
      .pipe(Effect.flatMap((taken) => (taken ? Effect.void : waiting(lock.take(1)))));
  /** Wait until every forked run is finished or waiting. */
  const quiet: Effect.Effect<void> = Effect.suspend(function wait(): Effect.Effect<void> {
    if (running === suspended) return Effect.void;
    return Deferred.await(changed).pipe(Effect.flatMap(wait));
  });
  const failures: Array<unknown> = [];
  const deaths: Array<{ saga: string; executionId: string; defect: unknown }> = [];
  const commits: Array<{ aggregate: string; id: string; index: number }> = [];
  // Scheduled commands by `aggregate/id/commandId`, so rescheduling replaces.
  const timers = new Map<string, Timer>();
  /** Fire every timer that is due on the platform's clock; each removes itself. */
  const fireDue: Effect.Effect<void> = Effect.suspend(() => {
    const due = [...timers.values()].filter((timer) => timer.at <= now());
    return Effect.forEach(due, (timer) => timer.fire, { discard: true });
  });

  const deliverAll: Effect.Effect<void> = Effect.suspend(function loop(): Effect.Effect<void> {
    const next = pending.shift();
    if (!next) {
      draining = false;
      return Effect.void;
    }
    draining = true;
    return next.run.pipe(Effect.flatMap(loop));
  });

  /**
   * Start the next queued item, if any. A read (view, projection, backfill job)
   * at the head runs next; otherwise `choose` picks among the writers queued
   * before the first read, each the first in its lane, so reads and writers
   * keep their queue order and each (source, target) delivers in order.
   */
  const startNext: Effect.Effect<string | undefined> = Effect.suspend(() => {
    if (pending.length === 0) return Effect.succeed(undefined);
    const ready: Array<number> = [];
    const seen = new Set<string>();
    for (const [i, work] of pending.entries()) {
      if (work.lane === undefined) break;
      if (seen.has(work.lane)) continue;
      seen.add(work.lane);
      ready.push(i);
    }
    const choice =
      ready.length > 1 && options.choose ? options.choose(ready.map((i) => pending[i]!.label)) : 0;
    const [work] = pending.splice(ready[choice] ?? 0, 1);
    return work!.run.pipe(Effect.as(work!.label));
  });

  /** One item at a time, each until every run it started is finished or waiting. */
  const drainManual: Effect.Effect<void> = Effect.suspend(function loop(): Effect.Effect<void> {
    return quiet.pipe(
      Effect.andThen(fireDue),
      Effect.andThen(quiet),
      Effect.andThen(
        Effect.suspend(() => {
          const from = commits.length;
          return startNext.pipe(
            Effect.flatMap((label) =>
              label === undefined
                ? Effect.void
                : quiet.pipe(
                    Effect.andThen(
                      Effect.sync(() =>
                        options.ran?.(
                          label,
                          commits.slice(from).map(({ aggregate, id }) => `${aggregate}/${id}`),
                        ),
                      ),
                    ),
                    Effect.andThen(loop()),
                  ),
            ),
          );
        }),
      ),
    );
  });

  const drain: Effect.Effect<void> = options.manual
    ? drainManual
    : fireDue.pipe(Effect.andThen(deliverAll));

  const enqueueWork = (work: ReadonlyArray<Work>) =>
    Effect.suspend(() => {
      pending.push(...work);
      if (options.manual || draining || pending.length === 0) return Effect.void;
      draining = true;
      return Effect.forkDetach(drain).pipe(Effect.asVoid);
    });

  const enqueue = (
    deliveries: ReadonlyArray<Delivery>,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) =>
    enqueueWork(
      deliveries.map((delivery) => ({
        run: deliver(delivery),
        label: `${delivery.target.kind} ${delivery.target.name} ← ${delivery.tag} (${delivery.source}#${delivery.seq})`,
        // Only policies write; views and projections keep their queue order.
        lane:
          delivery.target.kind === "policy"
            ? `${delivery.source}→${delivery.target.name}`
            : undefined,
      })),
    );

  /**
   * Fire `fire` at `at` while it is still the timer under `key` (not
   * cancelled, replaced or already fired): from `drain` as a story's clock
   * moves, otherwise in real time. `exclusive` wraps the check and the fire,
   * so a caller holding the same lock sees one or the other.
   */
  const timer = (
    key: string,
    at: number,
    fire: Effect.Effect<void>,
    exclusive: (effect: Effect.Effect<void>) => Effect.Effect<void> = (effect) => effect,
  ) =>
    Effect.suspend(() => {
      const armed: Timer = {
        at,
        fire: exclusive(
          Effect.suspend(() => {
            if (timers.get(key) !== armed) return Effect.void;
            timers.delete(key);
            return fire;
          }),
        ),
      };
      timers.set(key, armed);
      if (options.manual) return Effect.void;
      return Effect.forkDetach(
        Effect.sleep(Math.max(0, at - now())).pipe(Effect.andThen(fireDue)),
      ).pipe(Effect.asVoid);
    });

  const workflows = InMemoryWorkflows.make({
    now,
    // A run is forked like a policy run, so one waiting on an external system
    // doesn't hold up the queue.
    enqueue: (run, key) =>
      enqueueWork([
        {
          run: Effect.suspend(() => {
            started();
            return Effect.forkDetach(run.pipe(Effect.ensuring(stopped))).pipe(Effect.asVoid);
          }),
          label: `saga ${key}`,
          lane: `saga:${key}`,
        },
      ]),
    // With `manual`, a run's next Activity waits for its turn in the queue, so
    // a story decides whether it runs before the policies its last step triggered.
    turn: options.manual
      ? (key, activity) =>
          Effect.suspend(() => {
            const turn = Deferred.makeUnsafe<void>();
            pending.push({
              run: Deferred.succeed(turn, undefined).pipe(Effect.asVoid),
              label: `saga ${key} → ${activity}`,
              lane: `saga:${key}`,
            });
            return Deferred.await(turn).pipe(waiting);
          })
      : undefined,
    acquire,
    timer,
    failed: (cause) => void failures.push(cause),
    died: (saga, executionId, defect) => void deaths.push({ saga, executionId, defect }),
  });

  const control: Control = {
    drain,
    idle: Effect.sync(() => pending.length === 0 && !draining && running === suspended),
    suspended: waiting,
    failures,
    deaths,
    commits,
  };

  // Each model has its own storage and catch-up state, kept when the same
  // model is built again on this platform (a redeploy): models never share data.
  const hostFor = memo((modelName: string): ModelHost => {
    // Storage by entity, kept when a model is built again on this platform (a redeploy).
    const storage = new Map<string, unknown>();
    const stored = <T>(key: string, make: () => T): T => {
      if (!storage.has(key)) storage.set(key, make());
      return storage.get(key) as T;
    };
    // ---------------------------------------------------------------- backfill
    // Every source instance, consumer key and directory node is an object with its
    // own storage, kept across builds (deploys); its jobs run on the work queue.
    const memoryStorage = (address: string, lock: Semaphore.Semaphore): Backfill.Storage => {
      const data = stored(`bf:${address}`, () => new Map<string, unknown>());
      return {
        get: <A>(key: string) => Effect.sync(() => data.get(key) as A | undefined),
        put: (entries) =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(entries)) data.set(key, value);
          }),
        delete: (keys) =>
          Effect.sync(() => {
            for (const key of keys) data.delete(key);
          }),
        list: <A>(options: { prefix: string; startAfter?: string; limit?: number }) =>
          Effect.sync(() => {
            const out: Array<readonly [string, A]> = [];
            for (const key of [...data.keys()].sort()) {
              if (!key.startsWith(options.prefix)) continue;
              if (options.startAfter !== undefined && key <= options.startAfter) continue;
              out.push([key, data.get(key) as A]);
              if (options.limit !== undefined && out.length >= options.limit) break;
            }
            return out;
          }),
        exclusive: (effect) => lock.withPermits(1)(effect),
      };
    };
    // Queued jobs, by object and id: scheduling one already queued is a no-op.
    const scheduled = new Set<string>();
    const memoryJobs = (
      address: string,
      run: (id: string) => Effect.Effect<void>,
    ): Backfill.Jobs => ({
      schedule: (id, afterMillis) =>
        Effect.suspend(() => {
          const key = `${address}|${id}`;
          // A job that waits (on code that doesn't know a target yet) waits on the clock.
          if (afterMillis > 0)
            return timer(
              `bf|${key}`,
              now() + afterMillis,
              run(id).pipe(Effect.catchCause((cause) => Effect.sync(() => failures.push(cause)))),
            );
          if (scheduled.has(key)) return Effect.void;
          scheduled.add(key);
          return enqueueWork([
            {
              run: Effect.suspend(() => {
                scheduled.delete(key);
                return run(id).pipe(
                  Effect.catchCause((cause) => Effect.sync(() => failures.push(cause))),
                );
              }),
              label: `backfill ${key}`,
              lane: undefined,
            },
          ]);
        }),
    });
    const nodes = new Map<string, Backfill.Node>();
    const node = (path: string): Backfill.Node => {
      let found = nodes.get(path);
      if (!found) {
        const address = `node:${path}`;
        const lock = stored(`lock:${address}`, () => Semaphore.makeUnsafe(1));
        found = Backfill.makeNode(
          memoryStorage(address, lock),
          memoryJobs(address, (id) => node(path).run(id)),
          net,
          limits,
        );
        nodes.set(path, found);
      }
      return found;
    };
    // Every consumer in the model of the latest build, and the tuning: keys waiting on
    // discovery ask again on the work queue, as soon as other work has run.
    let model: ReadonlyArray<string> = [];
    let planOf: (target: string) => Backfill.Plan | undefined = () => undefined;
    const limits: Backfill.Limits = { ...Backfill.defaultLimits, pollMillis: 0 };
    // The source and consumer parts of each hosted entity, as of the latest build.
    const sourceRoles = new Map<string, (id: string) => Backfill.Source>();
    const consumerRoles = new Map<string, (key: string) => Backfill.Consumer>();
    const consumerRole = (target: string, key: string) => {
      const { kind, name } = Backfill.consumerOf(target);
      return consumerRoles.get(`${kind}:${name}`)?.(key);
    };
    /** Each consumer's routing of a source's stored rows, as of the latest build: what its scanners use. */
    const consumerRoutes = new Map<string, Backfill.ScannerHost["route"]>();
    const scanners = new Map<string, Backfill.Scanner>();
    /** The scanner of one source instance, for one consumer generation. */
    const scanner = (target: string, ref: Backfill.SourceRef) => {
      const address = `scanner:${target}/${ref.source}/${ref.id}`;
      let found = scanners.get(address);
      if (!found) {
        const lock = stored(`lock:${address}`, () => Semaphore.makeUnsafe(1));
        const { kind, name } = Backfill.consumerOf(target);
        const role: Backfill.Scanner = Backfill.makeScanner(
          memoryStorage(address, lock),
          memoryJobs(address, (id) => role.run(id)),
          net,
          {
            route: (target, ref, rows) =>
              consumerRoutes.get(`${kind}:${name}`)?.(target, ref, rows) ?? Effect.succeed([]),
          },
          limits,
        );
        scanners.set(address, (found = role));
      }
      return found;
    };
    const runs = new Map<string, Backfill.Run>();
    /** The root of a consumer generation's run. Each pass is one try at everything; keys work between. */
    const run = (target: string) => {
      let found = runs.get(target);
      if (!found) {
        const address = `run:${target}`;
        const lock = stored(`lock:${address}`, () => Semaphore.makeUnsafe(1));
        const role: Backfill.Run = Backfill.makeRun(
          memoryStorage(address, lock),
          memoryJobs(address, (id) => role.run(id)),
          net,
          { waitMillis: 0, againMillis: 0 },
        );
        runs.set(target, (found = role));
      }
      return found;
    };
    const net: Backfill.Network = {
      node: {
        register: (path, ref) => node(path).register(path, ref),
        child: (path, child) => node(path).child(path, child),
        list: (path, after) => node(path).list(path, after),
      },
      source: {
        // A source no longer in the model has nothing to give.
        cursor: (ref, target) =>
          Effect.suspend(
            () => sourceRoles.get(ref.source)?.(ref.id).cursor(target) ?? Effect.succeed(0),
          ),
        read: (ref, target, key, after, limit) =>
          Effect.suspend(
            () =>
              sourceRoles.get(ref.source)?.(ref.id).read(target, key, after, limit) ??
              Effect.succeed({ from: after, rows: [], handoff: "live" as const }),
          ),
        log: (ref, after, limit) =>
          Effect.suspend(
            () => sourceRoles.get(ref.source)?.(ref.id).log(after, limit) ?? Effect.succeed([]),
          ),
        handoff: (ref, target, key, through) =>
          Effect.suspend(
            () =>
              sourceRoles.get(ref.source)?.(ref.id).handoff(target, key, through) ??
              Effect.succeed("live" as const),
          ),
      },
      consumer: {
        push: (target, key, deliveries) =>
          Effect.suspend(() => consumerRole(target, key)?.push(target, deliveries) ?? Effect.void),
        ready: (target, key, waitMillis) =>
          Effect.suspend(
            () =>
              consumerRole(target, key)?.ready(target, waitMillis) ??
              Effect.succeed("settled" as const),
          ),
        start: (target, key, ref, waitMillis) =>
          Effect.suspend(
            () =>
              consumerRole(target, key)?.start(target, ref, waitMillis) ??
              Effect.succeed("settled" as const),
          ),
      },
      scanner: {
        scan: (target, ref, waitMillis) =>
          Effect.suspend(() => scanner(target, ref).scan(target, ref, waitMillis)),
        ready: (target, ref, waitMillis) =>
          Effect.suspend(() => scanner(target, ref).ready(target, waitMillis)),
        kick: (target, ref) => Effect.suspend(() => scanner(target, ref).kick(target, ref)),
      },
      relay: { run: (name, run, items) => Effect.suspend(() => relay.run(name, run, items)) },
      run: {
        begin: (target, plan) => Effect.suspend(() => run(target).begin(target, plan)),
        phase: (target) => Effect.suspend(() => run(target).phase(target)),
        progress: (target) => Effect.suspend(() => run(target).progress(target)),
      },
    };
    const relay = Backfill.makeRelay(net);
    /** List an instance in the directory; its first commit waits for it. */
    const register = (ref: Backfill.SourceRef) =>
      node(Backfill.leafOf(ref)).register(Backfill.leafOf(ref), ref);
    return {
      aggregate: (_aggregate, kit) =>
        Effect.sync(() => {
          const { instances, lock, versions } = stored(`aggregate:${kit.name}`, () => ({
            instances: new Map<
              string,
              {
                state: Json;
                version: number;
                readonly receipts: Map<string, SendResult>;
                /** The latest arming of each scheduled command, by its name. */
                readonly scheduled: Map<string, Armed>;
                readonly events: Array<StoredEvent>;
                /** How far its events were routed to each view and projection. */
                routed: Routed | undefined;
              }
            >(),
            lock: Semaphore.makeUnsafe(1),
            // The latest version of each instance that anyone watches.
            versions: new Map<string, SubscriptionRef.SubscriptionRef<number>>(),
          }));
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
                (found = {
                  state: null,
                  version: 0,
                  receipts: new Map(),
                  scheduled: new Map(),
                  events: [],
                  routed: undefined,
                }),
              );
            return found;
          };
          const sourceRole = memo((id: string) => {
            const address = `source:${kit.name}/${id}`;
            const role: Backfill.Source = Backfill.makeSource(
              memoryStorage(address, lock),
              memoryJobs(address, () => role.flush),
              net,
              {
                ref: { source: kit.name, id },
                model: () => model,
                singleSource: (target) => planOf(target)?.singleSource === true,
                log: (after, limit) =>
                  Effect.sync(() =>
                    instance(id)
                      .events.filter((event) => event.envelope.seq > after)
                      .slice(0, limit),
                  ),
                version: Effect.sync(() => instance(id).version),
                routed: Effect.sync(() => instance(id).routed),
                markLive: (target) =>
                  Effect.sync(() => {
                    const current = instance(id);
                    current.routed = { ...current.routed, [target]: current.version };
                  }),
              },
              limits,
            );
            return role;
          });
          sourceRoles.set(kit.name, sourceRole);
          // Callers hold `lock`.
          const commit = (id: string, command: Json, meta: Aggregate.SendMeta) =>
            Effect.gen(function* () {
              const current = instance(id);
              const duplicate = current.receipts.get(meta.commandId);
              if (duplicate) return duplicate;
              const result = yield* kit.handle({
                id,
                state: current.state,
                version: current.version,
                command,
                commandId: meta.commandId,
                context: meta.context,
                now: now(),
                correlationId: meta.correlationId,
                trace: meta.trace,
                link: meta.link,
              });
              if (result._tag === "Rejected") return result satisfies SendResult;
              if (current.version === 0) yield* register({ source: kit.name, id });
              const live = yield* Backfill.routeCommit(
                sourceRole(id),
                kit.targets,
                current.routed,
                current.version,
                result.version,
                result.deliveries,
              );
              current.routed = live.routed;
              current.state = result.state;
              current.version = result.version;
              for (let i = 0; i < result.events.length; i++)
                commits.push({ aggregate: kit.name, id, index: current.events.length + i });
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
              yield* enqueue(live.send, kit.deliver);
              return sent;
            });
          const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
            lock.withPermits(1)(commit(id, command, meta));
          return {
            send,
            schedule: (id, name, command, meta, due) =>
              lock.withPermits(1)(
                Effect.suspend(() => {
                  const { scheduled } = instance(id);
                  // The same arming again (a policy or step ran again): leave it as it is.
                  const armed = scheduled.get(name);
                  if (armed?.commandId === meta.commandId) return Effect.succeed(armed.at);
                  const at = "at" in due ? due.at : now() + due.afterMillis;
                  scheduled.set(name, { commandId: meta.commandId, at, cancelled: false });
                  return timer(
                    `${modelName}/${kit.name}/${id}/${name}`,
                    at,
                    commit(id, command, meta).pipe(Effect.asVoid),
                    lock.withPermits(1),
                  ).pipe(Effect.as(at));
                }),
              ),
            unschedule: (id, name) =>
              lock.withPermits(1)(
                Effect.suspend(
                  (): Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled> => {
                    const fields = { aggregate: kit.name, id, commandId: name };
                    const current = instance(id);
                    const armed = current.scheduled.get(name);
                    if (!armed) return Effect.fail(new NotScheduled(fields));
                    if (current.receipts.has(armed.commandId))
                      return Effect.fail(new AlreadyExecuted(fields));
                    if (armed.cancelled) return Effect.fail(new AlreadyCancelled(fields));
                    timers.delete(`${modelName}/${kit.name}/${id}/${name}`);
                    current.scheduled.set(name, { ...armed, cancelled: true });
                    return Effect.void;
                  },
                ),
              ),
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
                Effect.gen(function* () {
                  const current = instance(id);
                  const result = yield* kit.seed({
                    id,
                    state: current.state,
                    version: current.version,
                    events,
                    commandId: `seed:${id}:${current.version}`,
                    now: now(),
                  });
                  if (current.version === 0) yield* register({ source: kit.name, id });
                  const live = yield* Backfill.routeCommit(
                    sourceRole(id),
                    kit.targets,
                    current.routed,
                    current.version,
                    result.version,
                    result.deliveries,
                  );
                  current.routed = live.routed;
                  current.state = result.state;
                  current.version = result.version;
                  current.events.push(...result.events);
                  yield* announce(id);
                  yield* enqueue(live.send, kit.deliver);
                }),
              ),
          };
        }),

      view: (_view, kit) =>
        Effect.sync(() => {
          const stash = stored(`view:${kit.name}`, () => ({
            /** The generation the stored keys were built by. */
            generation: 0,
            keys: new Map<
              string,
              {
                readonly snapshot: SubscriptionRef.SubscriptionRef<ViewSnapshot>;
                readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyArray<ViewEntry>>;
                /** The key's immutable input log: every delivery it applied, in order. */
                readonly inputs: Array<Delivery>;
                /** How far its entries were routed to each view and projection. */
                routed: Routed | undefined;
              }
            >(),
            lock: Semaphore.makeUnsafe(1),
          }));
          const { keys, lock } = stash;
          // Rebuilt (a new generation): start every key over; the history is replayed to it.
          if (stash.generation < kit.generation) {
            keys.clear();
            stash.generation = kit.generation;
          }
          const get = (key: string) =>
            Effect.suspend(() => {
              const found = keys.get(key);
              if (found) return Effect.succeed(found);
              return Effect.all({
                snapshot: SubscriptionRef.make(emptySnapshot),
                entries: SubscriptionRef.make<ReadonlyArray<ViewEntry>>([]),
              }).pipe(
                Effect.map((created) => ({
                  ...created,
                  inputs: [] as Array<Delivery>,
                  routed: undefined as Routed | undefined,
                })),
                Effect.tap((created) => Effect.sync(() => keys.set(key, created))),
              );
            });
          const target = kit.target;
          /** Apply deliveries to a key and route what it emits. Callers hold `lock`. */
          const apply = (key: string, deliveries: ReadonlyArray<Delivery>) =>
            Effect.gen(function* () {
              const current = yield* get(key);
              const before = yield* SubscriptionRef.get(current.snapshot);
              const result = yield* kit.apply(key, before, deliveries);
              if (!result.changed) return;
              current.inputs.push(
                ...deliveries.filter((d) => (before.checkpoints[d.source] ?? 0) < d.seq),
              );
              if (result.entries.length > 0) {
                yield* SubscriptionRef.update(current.entries, (entries) => [
                  ...entries,
                  ...result.entries,
                ]);
              }
              const live = yield* Backfill.routeCommit(
                sourceRole(key),
                kit.targets,
                current.routed,
                before.seq,
                result.snapshot.seq,
                result.downstream,
              );
              current.routed = live.routed;
              yield* SubscriptionRef.set(current.snapshot, result.snapshot);
              yield* enqueue(live.send, kit.deliver);
            }).pipe(kit.observe(key, deliveries));
          // As a consumer: buffers and merges history while a backfill runs.
          const consumer = memo((key: string) => {
            const address = `consumer:${target}/${key}`;
            const role: Backfill.Consumer = Backfill.makeConsumer(
              memoryStorage(address, lock),
              memoryJobs(address, (id) => role.merge(id.slice("bf-merge:".length))),
              net,
              {
                key,
                target: () => target,
                singleSource: () => kit.singleSource,
                sources: () => planOf(target)?.sources ?? [],
                history: (ref, rows) => kit.history(target, ref.source, ref.id, rows),
                apply: (deliveries) => apply(key, deliveries),
              },
              limits,
            );
            return role;
          });
          consumerRoles.set(`view:${kit.name}`, consumer);
          consumerRoutes.set(`view:${kit.name}`, (target, ref, rows) =>
            kit.history(target, ref.source, ref.id, rows),
          );
          // As a source: other views and projections read its entries.
          const sourceRole = memo((key: string) => {
            const address = `source:${kit.name}/${key}`;
            const entries = Effect.flatMap(get(key), (current) =>
              SubscriptionRef.get(current.entries),
            );
            const role: Backfill.Source = Backfill.makeSource(
              memoryStorage(address, lock),
              memoryJobs(address, () => role.flush),
              net,
              {
                ref: { source: kit.name, id: key },
                model: () => model,
                singleSource: (target) => planOf(target)?.singleSource === true,
                log: (after, limit) =>
                  Effect.map(entries, (all) =>
                    all.filter((entry) => entry.seq > after).slice(0, limit),
                  ),
                version: Effect.flatMap(get(key), (current) =>
                  Effect.map(SubscriptionRef.get(current.snapshot), (snapshot) => snapshot.seq),
                ),
                routed: Effect.map(get(key), (current) => current.routed),
                markLive: (target) =>
                  Effect.gen(function* () {
                    const current = yield* get(key);
                    const { seq } = yield* SubscriptionRef.get(current.snapshot);
                    current.routed = { ...current.routed, [target]: seq };
                  }),
              },
              limits,
            );
            return role;
          });
          // A key of a view keyed by its one aggregate reads its history from that
          // instance before it answers anything, the first time: when the view is
          // lazy, or rebuilt in place. After that, it is read like any other.
          const caughtUp = new Set<string>();
          const ready = (key: string): Effect.Effect<void> =>
            Effect.suspend(() => {
              const catchUp = kit.catchUp;
              if (catchUp === undefined || caughtUp.has(key)) return Effect.void;
              const ref = { source: catchUp.source, id: key };
              return consumer(key)
                .start(target, ref, 5_000)
                .pipe(
                  Effect.repeat({ until: (started) => started === "settled", times: 20 }),
                  Effect.tap((started) =>
                    Effect.sync(() => {
                      if (started === "settled") caughtUp.add(key);
                    }),
                  ),
                  Effect.asVoid,
                );
            });
          // Read as a source (by a view or projection catching up), a key has its
          // own history first: what reads it never sees a key still filling.
          sourceRoles.set(kit.name, (key) => {
            const role = sourceRole(key);
            const first = ready(key);
            return {
              ...role,
              log: (after, limit) => Effect.andThen(first, role.log(after, limit)),
              cursor: (target) => Effect.andThen(first, role.cursor(target)),
              read: (target, at, after, limit) =>
                Effect.andThen(first, role.read(target, at, after, limit)),
              handoff: (target, at, through) =>
                Effect.andThen(first, role.handoff(target, at, through)),
            };
          });
          return {
            receive: (key, deliveries) =>
              Effect.gen(function* () {
                // A key is listed as a source before it first applies anything.
                if (!keys.has(key)) yield* register({ source: kit.name, id: key });
                if (yield* consumer(key).admit(target, deliveries))
                  yield* lock.withPermits(1)(apply(key, deliveries));
              }),
            read: (key) =>
              ready(key).pipe(
                Effect.andThen(get(key)),
                Effect.flatMap((current) => SubscriptionRef.get(current.snapshot)),
              ),
            changes: (key) =>
              Stream.unwrap(
                ready(key).pipe(
                  Effect.andThen(get(key)),
                  Effect.map((current) => SubscriptionRef.changes(current.snapshot)),
                ),
              ),
            // A live read's WebSocket is served here, pushed on every commit.
            connect: (key, subscription) =>
              ready(key).pipe(
                Effect.andThen(get(key)),
                Effect.flatMap((current) =>
                  serveSocket(
                    subscription,
                    (latest) =>
                      Effect.flatMap(
                        Effect.all([
                          SubscriptionRef.get(current.snapshot),
                          SubscriptionRef.get(current.entries),
                        ]),
                        ([snapshot, entries]) => kit.push(key, latest, snapshot, entries),
                      ),
                    SubscriptionRef.changes(current.snapshot).pipe(Stream.drop(1)),
                  ),
                ),
              ),
            list: (key, range) =>
              ready(key).pipe(
                Effect.andThen(get(key)),
                Effect.flatMap((current) => SubscriptionRef.get(current.entries)),
                Effect.map((entries) => inRange(entries, range)),
              ),
            tail: (key, after) =>
              Stream.unwrap(
                ready(key).pipe(
                  Effect.andThen(get(key)),
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
          const stash = stored(`projection:${kit.name}`, () => ({
            /** The generation the stored logs were built by. */
            generation: 0,
            partitions: new Map<string, Partition>(),
          }));
          const { partitions } = stash;
          // Rebuilt (a new generation): start every key's log over; the history is replayed to it.
          if (stash.generation < kit.generation) {
            partitions.clear();
            stash.generation = kit.generation;
          }
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
              return exclusively(p.lock)(
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
                        started();
                        yield* Effect.forkDetach(
                          Effect.sleep(batch.waitMillis - (now() - oldest.at)).pipe(
                            Effect.andThen(
                              Effect.sync(() => {
                                p.timer = false;
                              }),
                            ),
                            Effect.andThen(process(key, true)),
                            Effect.ensuring(stopped),
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
          /** Accept a delivery into its key's log (once), then handle the log. */
          const intake = (delivery: Delivery) =>
            Effect.suspend(() => {
              // For an earlier generation of the projection: nothing to run.
              if ((delivery.target.generation ?? 0) < kit.generation) return Effect.void;
              const p = partition(delivery.key);
              if ((p.intake[delivery.source] ?? 0) >= delivery.seq) return Effect.void;
              p.intake[delivery.source] = delivery.seq;
              p.log.push({ position: p.log.length + 1, delivery, at: now() });
              started();
              return Effect.forkDetach(
                process(delivery.key, false).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => failures.push(cause)).pipe(
                      Effect.andThen(Effect.logError(`projection ${kit.name} failed`, cause)),
                    ),
                  ),
                  Effect.ensuring(stopped),
                ),
              ).pipe(Effect.asVoid);
            });
          const target = targetId({
            kind: "projection",
            name: kit.name,
            ...(kit.generation > 0 ? { generation: kit.generation } : {}),
          });
          // Buffers and merges history while a backfill runs.
          const consumer = memo((key: string) => {
            const address = `consumer:${target}/${key}`;
            const role: Backfill.Consumer = Backfill.makeConsumer(
              memoryStorage(address, partition(key).lock),
              memoryJobs(address, (id) => role.merge(id.slice("bf-merge:".length))),
              net,
              {
                key,
                target: () => target,
                singleSource: () => kit.singleSource,
                sources: () => planOf(target)?.sources ?? [],
                history: (ref, rows) => kit.history(target, ref.source, ref.id, rows),
                apply: (deliveries) => Effect.forEach(deliveries, intake, { discard: true }),
              },
              limits,
            );
            return role;
          });
          consumerRoles.set(`projection:${kit.name}`, consumer);
          consumerRoutes.set(`projection:${kit.name}`, (target, ref, rows) =>
            kit.history(target, ref.source, ref.id, rows),
          );
          return {
            receive: (delivery) =>
              Effect.gen(function* () {
                if (yield* consumer(delivery.key).admit(target, [delivery]))
                  yield* intake(delivery);
              }),
            checkpoints: (key) => Effect.sync(() => ({ ...partition(key).checkpoints })),
          };
        }),

      stream: (_stream, kit) =>
        Effect.sync(() => {
          const { keys, lock } = stored(`stream:${kit.name}`, () => ({
            keys: new Map<
              string,
              {
                readonly meta: SubscriptionRef.SubscriptionRef<StreamMeta>;
                readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyArray<StreamEntry>>;
              }
            >(),
            lock: Semaphore.makeUnsafe(1),
          }));
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
                        stream: `${kit.name}/${key}`,
                        seq,
                        at: write.at,
                        commandId: write.commandId,
                      },
                    };
                  });
                  yield* SubscriptionRef.update(current.entries, (entries) => [
                    ...entries,
                    ...added,
                  ]);
                  yield* SubscriptionRef.set(current.meta, {
                    seq: meta.seq + added.length,
                    origin: write.origin,
                    checkpoints: {
                      ...meta.checkpoints,
                      [write.source]: Math.max(
                        meta.checkpoints[write.source] ?? 0,
                        write.sourceSeq,
                      ),
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
            // A live read's WebSocket is served here, pushed on every append.
            connect: (key, subscription) =>
              get(key).pipe(
                Effect.flatMap((current) =>
                  serveSocket(
                    subscription,
                    (latest) =>
                      Effect.flatMap(
                        Effect.all([
                          SubscriptionRef.get(current.meta),
                          SubscriptionRef.get(current.entries),
                        ]),
                        ([meta, entries]) => kit.push(key, latest, meta, entries, entries.at(-1)),
                      ),
                    SubscriptionRef.changes(current.meta).pipe(Stream.drop(1)),
                  ),
                ),
              ),
            list: (key, range) =>
              get(key).pipe(
                Effect.flatMap((current) => SubscriptionRef.get(current.entries)),
                Effect.map((entries) => inRange(entries, range)),
              ),
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
          const locks = stored(`policy:${kit.name}`, () => new Map<string, Semaphore.Semaphore>());
          const lockFor = (key: string) => {
            let found = locks.get(key);
            if (!found) locks.set(key, (found = Semaphore.makeUnsafe(1)));
            return found;
          };
          return {
            receive: (delivery) =>
              Effect.suspend(() => {
                started();
                return exclusively(lockFor(delivery.key))(kit.run(delivery)).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => failures.push(cause)).pipe(
                      Effect.andThen(Effect.logError(`policy ${kit.name} failed`, cause)),
                    ),
                  ),
                  Effect.ensuring(stopped),
                  Effect.forkDetach,
                  Effect.asVoid,
                );
              }),
          };
        }),

      // A deploy that adds consumers starts their runs.
      start: (targets, plans, backfill) =>
        Effect.suspend(() => {
          model = targets;
          planOf = plans;
          return Effect.forEach(
            backfill,
            (target) => {
              const plan = plans(target);
              if (plan === undefined) return Effect.void;
              // A consumer that reads other sources than its run started with, at the same
              // version: building the model fails, saying to bump the version.
              return Effect.flatMap(run(target).begin(target, plan), (begun) =>
                begun.status === "changed"
                  ? Effect.die(
                      new Backfill.PlanChanged({
                        message: Backfill.planChanged(target, begun.started, plan),
                      }),
                    )
                  : Effect.void,
              );
            },
            { discard: true },
          );
        }),
      history: (target) =>
        Effect.map(run(target).phase(target), (phase) => ({ complete: phase === "complete" })),
    };
  });
  const claim = hostedModels({ release: true });
  const platform = Platform.of({
    model: ({ modelName, id }) => Effect.as(claim(modelName, id), hostFor(modelName)),
  });

  return {
    layer: Layer.mergeAll(
      Layer.succeed(Platform, platform),
      Layer.succeed(WorkflowEngine.WorkflowEngine, workflows),
      SecureRandom.layerWebCrypto,
    ),
    control,
  };
};

/**
 * Host a domain model in the current process: aggregates, views and policies,
 * with nothing to deploy. Use it in tests and single-process apps; swap it
 * for `DomainCloudflare.layerDurableObjects()` and nothing else changes.
 *
 * ### Hosting in memory
 * **Example:** A model with its policies
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
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
export const InMemory: Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom
> = Layer.suspend(() => make().layer);

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
