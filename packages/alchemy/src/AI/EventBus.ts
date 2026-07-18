import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Event } from "./Event.ts";

/**
 * The same-harness event bus — an OPTIONAL kernel **component**
 * (kernel-pruning ruling, 2026-07-17: components are Layers an
 * assembly names; no implementation fabricates them). Its ONE kernel
 * job is `ctx.emit` fan-out: an org-owned {@link Event} a process emits
 * reaches same-harness subscribers (a server's SSE tail, a test's
 * assertion). The kernel never subscribes anything — run endings are
 * exclusively `settle(key, event)` from the implementation Layer that
 * consumed the wire.
 *
 * `subscribe` is effectful — the subscription registers NOW (scoped to
 * the caller), so events published between registration and
 * consumption are buffered. `publish` is the harness-side injection
 * point.
 *
 * `AI.memory` (the reference assembly) includes {@link EventBusMemory}
 * explicitly; Layers are memoized by reference, so a harness that also
 * provides it shares the kernel's instance.
 */
export interface EventBusService {
  /** Inject a world event for a source (by source or by its name). */
  publish(source: Event<any> | string, event: unknown): Effect.Effect<void>;
  /**
   * Subscribe to a source's events: registers now (buffered from this
   * point), delivers as a stream. The subscription lives in the
   * caller's Scope.
   */
  subscribe(
    source: Event<any> | string,
  ): Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
}

export class EventBus extends Context.Service<EventBus, EventBusService>()(
  "alchemy/AI/EventBus",
) {}

const nameOf = (source: Event<any> | string): string =>
  typeof source === "string" ? source : source["~alchemy/Name"];

export const makeMemoryEventBus: Effect.Effect<EventBusService> = Effect.gen(
  function* () {
    const topics = new Map<string, PubSub.PubSub<unknown>>();
    const topic = (name: string) =>
      Effect.gen(function* () {
        const existing = topics.get(name);
        if (existing !== undefined) return existing;
        const created = yield* PubSub.unbounded<unknown>();
        topics.set(name, created);
        return created;
      });

    return {
      publish: (source, event) =>
        Effect.flatMap(topic(nameOf(source)), (pubsub) =>
          Effect.asVoid(PubSub.publish(pubsub, event)),
        ),
      subscribe: (source) =>
        Effect.gen(function* () {
          const pubsub = yield* topic(nameOf(source));
          const subscription = yield* PubSub.subscribe(pubsub);
          return Stream.fromSubscription(subscription);
        }),
    };
  },
);

export const EventBusMemory: Layer.Layer<EventBus> = Layer.effect(
  EventBus,
  Effect.map(makeMemoryEventBus, (bus) => EventBus.of(bus)),
);

/**
 * The NAMED absence of the component — an assembly that wants no
 * same-harness fan-out says so explicitly (kernel-pruning ruling: no
 * silent defaults, no optional polling — a kernel's components are
 * always named). Publications go nowhere; subscriptions never deliver;
 * `ctx.emit` remains a durable Trace row.
 */
export const EventBusNone: Layer.Layer<EventBus> = Layer.succeed(
  EventBus,
  EventBus.of({
    publish: () => Effect.void,
    subscribe: () => Effect.succeed(Stream.never),
  }),
);
