import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeCallback } from "../Callback.ts";
import { DurableObject as CloudflareDurableObject } from "../Cloudflare/Workers/DurableObject.ts";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";
import type { Worker } from "../Cloudflare/Workers/Worker.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { captureContext } from "./internal.ts";
import {
  type AggregateKit,
  type Delivery,
  emptyFeedState,
  emptySnapshot,
  type FeedEntry,
  type FeedKit,
  type FeedState,
  FoldPlatform,
  type Json,
  type PolicyKit,
  type SendResult,
  type StoredEvent,
  type ViewKit,
  type ViewSnapshot,
} from "./Platform.ts";

const pad = (n: number) => n.toString().padStart(12, "0");

const DefectTag = "alchemy/Fold/Defect";

/**
 * Workers RPC replaces thrown errors with an opaque "internal error". Return
 * failures as data instead, and rethrow them as defects on the calling side.
 */
const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/** A failed RPC call or a reported defect is a defect for the caller. */
const unwrapDefects = <A>(effect: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(
    Effect.catch((error) => Effect.die(error)),
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/** A Durable Object stub: every method is an RPC returning an Effect. */
interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

interface Namespace {
  readonly getByName: (name: string) => Stub;
}

/** What an instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

/** The usual outer (construction) / inner (instance) pair. */
type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a factory.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/**
 * Run `effect` with every other event on this instance held back. Durable
 * Objects run each event in its own I/O context, so cross-event in-memory
 * coordination (semaphores, refs, deferreds) is unsafe; the platform's gate
 * is not.
 */
const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const exit = yield* state.blockConcurrencyWhile(() => Effect.exit(effect));
    return yield* exit;
  });

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
    const state = yield* DurableObjectState;
    const prefix = `${name}:`;
    const lease = `${name}-lease`;
    const acquire = exclusively(
      Effect.gen(function* () {
        const held = yield* state.storage.get<number>(lease);
        if (held !== undefined && held > Date.now()) return false;
        yield* state.storage.put(lease, Date.now() + LEASE_MS);
        return true;
      }),
    );
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
    const callback = yield* makeCallback(`fold:${name}`, () => drain);
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
          yield* callback.schedule("drain", { after: "10 seconds", payload: {} });
        }),
      /** Process staged rows now, in the background, keeping the instance alive until done. */
      kick: state.waitUntil(drain.pipe(Effect.ignoreCause)),
    };
  });

const aggregateObject = (kit: AggregateKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      return {
        send: (id: string, command: Json, meta: { readonly commandId: string }) =>
          reportDefects(
            Effect.gen(function* () {
              const { sent, kick } = yield* exclusively(
                Effect.gen(function* () {
                  const duplicate = yield* state.storage.get<SendResult>(
                    `receipt:${meta.commandId}`,
                  );
                  if (duplicate) return { sent: duplicate, kick: false };
                  const current = (yield* state.storage.get<{
                    state: Json | null;
                    version: number;
                  }>("meta")) ?? {
                    state: null,
                    version: 0,
                  };
                  const result = yield* Effect.sync(() =>
                    kit.handle({
                      id,
                      state: current.state,
                      version: current.version,
                      command,
                      commandId: meta.commandId,
                      now: Date.now(),
                    }),
                  );
                  if (result._tag === "Rejected")
                    return { sent: result as SendResult, kick: false };
                  const sent: SendResult = {
                    _tag: "Accepted",
                    receipt: {
                      stream: `${kit.name}/${id}`,
                      version: result.version,
                      events: result.events.map((e) => e.event),
                      reply: result.reply,
                    },
                  };
                  yield* state.storage.transaction(
                    Effect.gen(function* () {
                      const events: Record<string, StoredEvent> = {};
                      for (const event of result.events)
                        events[`event:${pad(event.envelope.seq)}`] = event;
                      yield* state.storage.put(events);
                      yield* state.storage.put("meta", {
                        state: result.state,
                        version: result.version,
                      });
                      yield* state.storage.put(`receipt:${meta.commandId}`, sent);
                      yield* outbox.stage(result.deliveries);
                    }),
                  );
                  return { sent, kick: result.deliveries.length > 0 };
                }),
              );
              if (kick) yield* outbox.kick;
              return sent;
            }),
          ),
        state: () =>
          reportDefects(
            state.storage
              .get<{ state: Json | null; version: number }>("meta")
              .pipe(Effect.map((meta) => meta ?? { state: null, version: 0 })),
          ),
      };
    });
  });

const viewObject = (kit: ViewKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      const read = state.storage
        .get<ViewSnapshot>("snapshot")
        .pipe(Effect.map((s) => s ?? emptySnapshot));
      return {
        receive: (key: string, deliveries: ReadonlyArray<Delivery>) =>
          reportDefects(
            Effect.gen(function* () {
              const kick = yield* exclusively(
                Effect.gen(function* () {
                  const result = kit.apply(key, yield* read, deliveries);
                  if (!result.changed) return false;
                  yield* state.storage.transaction(
                    Effect.gen(function* () {
                      yield* state.storage.put("snapshot", result.snapshot);
                      yield* outbox.stage(result.downstream);
                    }),
                  );
                  return result.downstream.length > 0;
                }),
              );
              if (kick) yield* outbox.kick;
            }),
          ),
        read: () => reportDefects(read),
      };
    });
  });

const feedObject = (kit: FeedKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const entriesAfter = (after: number) =>
        state.storage
          .list<FeedEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      return {
        receive: (key: string, deliveries: ReadonlyArray<Delivery>) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const cursor = (yield* state.storage.get<FeedState>("state")) ?? emptyFeedState;
                const result = kit.append(key, cursor, deliveries);
                const rows: Record<string, FeedEntry> = {};
                for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
                yield* state.storage.transaction(
                  Effect.gen(function* () {
                    yield* state.storage.put(rows);
                    yield* state.storage.put("state", result.state);
                  }),
                );
              }),
            ),
          ),
        list: () => reportDefects(entriesAfter(0)),
        after: (after: number) => reportDefects(entriesAfter(after)),
      };
    });
  });

const policyObject = (kit: PolicyKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
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
  });

/** How often a subscription re-reads the Durable Object that owns a key. */
const POLL = Schedule.spaced("300 millis");

/**
 * Host a Domain on Cloudflare Durable Objects.
 *
 * Every aggregate, view, feed and policy becomes a Durable Object class on
 * the host Worker (`AccountAggregate`, `AccountSummaryView`, `StatementFeed`,
 * `FraudReviewPolicy`), declared while the Domain's Layer is built, so no
 * bindings or exports are written by hand:
 *
 * - **Aggregates**: one instance per id. Commands are serialized; events,
 *   state, the receipt (for idempotency) and an outbox commit in one storage
 *   transaction. The outbox is delivered right after the commit, in order,
 *   with a durable callback as the backstop.
 * - **Views and feeds**: one instance per key, with per-source checkpoints so
 *   repeated deliveries are harmless. `watch` and `tail` poll the instance
 *   that owns the key.
 * - **Policies**: one instance per (policy, source instance), running
 *   triggers in order from a durable inbox.
 *
 * **Example:** Hosting a domain in a Worker
 * ```typescript
 * const BankLive = Layer.mergeAll(CustomerApiLive, CustomerSessionLive).pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(Layer.mergeAll(FoldCloudflare.DurableObjects, Ports)),
 * );
 * ```
 */
export const DurableObjects: Layer.Layer<FoldPlatform, never, Worker> = Layer.effect(
  FoldPlatform,
  Effect.gen(function* () {
    // Factories run while the Domain's Layer is built, inside the Worker's
    // init phase; declaring a Durable Object needs that context.
    const init = yield* captureContext<Worker>();
    const inInit = <A, E>(effect: Effect.Effect<A, E, Worker>): Effect.Effect<A, E> =>
      Effect.provide(effect, init);

    return FoldPlatform.of({
      aggregate: (aggregate, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${aggregate.aggregateName}Aggregate`,
              aggregateObject(kit),
            );
            return {
              send: (id, command, meta) =>
                unwrapDefects(namespace.getByName(id).send(id, command, meta)),
              state: (id) => unwrapDefects(namespace.getByName(id).state()),
            };
          }),
        ),
      view: (view, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${view.viewName}View`, viewObject(kit));
            const read = (key: string) =>
              unwrapDefects<ViewSnapshot>(namespace.getByName(key).read());
            return {
              receive: (key, deliveries) =>
                unwrapDefects(namespace.getByName(key).receive(key, deliveries)),
              read,
              // Polls from the caller; push over hibernatable WebSockets is the next step.
              changes: (key) =>
                Stream.fromEffectSchedule(read(key), POLL).pipe(
                  Stream.changesWith((a, b) => a.version === b.version),
                ),
            };
          }),
        ),
      feed: (feed, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${feed.feedName}Feed`, feedObject(kit));
            return {
              receive: (key, deliveries) =>
                unwrapDefects(namespace.getByName(key).receive(key, deliveries)),
              list: (key) => unwrapDefects(namespace.getByName(key).list()),
              tail: (key, after) =>
                Stream.suspend(() => {
                  let first = true;
                  return Stream.paginate(after, (cursor: number) => {
                    const poll = unwrapDefects<ReadonlyArray<FeedEntry>>(
                      namespace.getByName(key).after(cursor),
                    );
                    const next = first ? poll : Effect.delay(poll, "300 millis");
                    first = false;
                    return Effect.map(
                      next,
                      (fresh) =>
                        [
                          fresh,
                          Option.some(fresh.length > 0 ? fresh[fresh.length - 1]!.seq : cursor),
                        ] as const,
                    );
                  });
                }),
            };
          }),
        ),
      policy: (policy, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${policy.policyName}Policy`, policyObject(kit));
            return {
              receive: (delivery) =>
                unwrapDefects(namespace.getByName(delivery.key).receive(delivery)),
            };
          }),
        ),
    });
  }),
);
