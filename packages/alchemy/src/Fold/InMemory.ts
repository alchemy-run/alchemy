import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  type Delivery,
  emptyFeedState,
  emptySnapshot,
  type FeedEntry,
  type FeedState,
  FoldPlatform,
  type Json,
  type SendResult,
  type StoredEvent,
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
  /** Deliver every queued delivery (and those it produces) until the queue is empty. */
  readonly drain: Effect.Effect<void>;
  /** `true` when nothing is queued and every running policy is suspended. */
  readonly idle: Effect.Effect<boolean>;
  /** Mark the current policy run as suspended while `effect` runs (story ports). */
  readonly suspended: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Defects raised by policy runs. */
  readonly failures: ReadonlyArray<unknown>;
}

/**
 * Build an in-memory platform and its control surface.
 */
export const make = (
  options: Options = {},
): { readonly layer: Layer.Layer<FoldPlatform>; readonly control: Control } => {
  const now = options.now ?? (() => Date.now());
  const pending: Array<{
    readonly delivery: Delivery;
    readonly deliver: (d: Delivery) => Effect.Effect<void>;
  }> = [];
  let draining = false;
  let running = 0;
  let suspended = 0;
  const failures: Array<unknown> = [];

  const drain: Effect.Effect<void> = Effect.suspend(function loop(): Effect.Effect<void> {
    const next = pending.shift();
    if (!next) {
      draining = false;
      return Effect.void;
    }
    draining = true;
    return next.deliver(next.delivery).pipe(Effect.flatMap(loop));
  });

  const enqueue = (
    deliveries: ReadonlyArray<Delivery>,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) =>
    Effect.suspend(() => {
      for (const delivery of deliveries) pending.push({ delivery, deliver });
      if (options.manual || draining || pending.length === 0) return Effect.void;
      draining = true;
      return Effect.forkDetach(drain).pipe(Effect.asVoid);
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
  };

  const platform = FoldPlatform.of({
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
        const instance = (id: string) => {
          let found = instances.get(id);
          if (!found)
            instances.set(
              id,
              (found = { state: null, version: 0, receipts: new Map(), events: [] }),
            );
          return found;
        };
        return {
          send: (id, command, meta) =>
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
                yield* enqueue(result.deliveries, kit.deliver);
                return sent;
              }),
            ),
          state: (id) =>
            Effect.sync(() => ({ state: instance(id).state, version: instance(id).version })),
          events: (id) => Effect.sync(() => [...instance(id).events]),
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
                return enqueue(
                  result.deliveries.filter((d) => d.target.kind !== "policy"),
                  kit.deliver,
                );
              }),
            ),
        };
      }),

    view: (_view, kit) =>
      Effect.sync(() => {
        const keys = new Map<string, SubscriptionRef.SubscriptionRef<ViewSnapshot>>();
        const lock = Semaphore.makeUnsafe(1);
        const ref = (key: string) =>
          Effect.suspend(() => {
            const found = keys.get(key);
            if (found) return Effect.succeed(found);
            return SubscriptionRef.make(emptySnapshot).pipe(
              Effect.tap((created) => Effect.sync(() => keys.set(key, created))),
            );
          });
        return {
          receive: (key, deliveries) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const r = yield* ref(key);
                const result = kit.apply(key, yield* SubscriptionRef.get(r), deliveries);
                if (!result.changed) return;
                yield* SubscriptionRef.set(r, result.snapshot);
                yield* enqueue(result.downstream, kit.deliver);
              }),
            ),
          read: (key) => ref(key).pipe(Effect.flatMap(SubscriptionRef.get)),
          changes: (key) => Stream.unwrap(ref(key).pipe(Effect.map(SubscriptionRef.changes))),
        };
      }),

    feed: (_feed, kit) =>
      Effect.sync(() => {
        const keys = new Map<
          string,
          {
            state: FeedState;
            readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyArray<FeedEntry>>;
          }
        >();
        const lock = Semaphore.makeUnsafe(1);
        const get = (key: string) =>
          Effect.suspend(() => {
            const found = keys.get(key);
            if (found) return Effect.succeed(found);
            return SubscriptionRef.make<ReadonlyArray<FeedEntry>>([]).pipe(
              Effect.map((entries) => {
                const created = { state: emptyFeedState, entries };
                keys.set(key, created);
                return created;
              }),
            );
          });
        return {
          receive: (key, deliveries) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* get(key);
                const result = kit.append(key, current.state, deliveries);
                current.state = result.state;
                if (result.entries.length > 0) {
                  yield* SubscriptionRef.update(current.entries, (entries) => [
                    ...entries,
                    ...result.entries,
                  ]);
                }
              }),
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

  return { layer: Layer.succeed(FoldPlatform, platform), control };
};

/**
 * An in-memory platform: every aggregate, view, feed and policy lives in the
 * current process. Use it for tests and single-process servers.
 */
export const InMemory: Layer.Layer<FoldPlatform> = Layer.suspend(() => make().layer);
