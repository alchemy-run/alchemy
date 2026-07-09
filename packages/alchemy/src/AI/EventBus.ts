import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { EventSource } from "./EventSource.ts";

/**
 * The harness's own event bus — the delivery channel for
 * **kernel-internal** {@link EventSource}s (`Channel = never`): sources
 * declared without a channel tag are deliverable only by the harness
 * itself (tests, `AI.Kernel.memory`, cross-ring stimuli produced by
 * tool side effects on the same harness).
 *
 * The shape mirrors `EventChannelService`: `subscribe` is effectful —
 * the subscription registers NOW (scoped to the caller, i.e. the loop's
 * interpretation Scope), so events published between interpretation and
 * `run()` are buffered, mirroring a real channel's provision-then-
 * deliver split. `publish` is the world-side injection point.
 *
 * A seam (§2.6): the kernel resolves it via `Effect.serviceOption` with
 * the in-memory default; provide {@link EventBusMemory} explicitly in a
 * test to hold the publishing side.
 */
export interface EventBusService {
  /** Inject a world event for a source (by source or by its name). */
  publish(
    source: EventSource<any, any, any> | string,
    event: unknown,
  ): Effect.Effect<void>;
  /**
   * Subscribe to a source's events: registers now (buffered from this
   * point), delivers as a stream. The subscription lives in the
   * caller's Scope.
   */
  subscribe(
    source: EventSource<any, any, any> | string,
  ): Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
}

export class EventBus extends Context.Service<EventBus, EventBusService>()(
  "alchemy/AI/EventBus",
) {}

const nameOf = (source: EventSource<any, any, any> | string): string =>
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
