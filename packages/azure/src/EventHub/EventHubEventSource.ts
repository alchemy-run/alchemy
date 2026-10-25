import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** One batch of events from one partition. */
export interface EventHubBatch {
  /** Event bodies, JSON-decoded when they are JSON. */
  events: unknown[];
  /** Per-event enqueue times. */
  enqueuedTimesUtc: string[];
  /** Per-event sequence numbers. */
  sequenceNumbers: number[];
  /** All trigger metadata the host passed (`PartitionContext`, `PropertiesArray`, …). */
  metadata: Record<string, unknown>;
}

export interface EventHubEventSourceProps {
  /**
   * Consumer group to read with. Give each consumer its own group.
   * @default "$Default"
   */
  consumerGroup?: string;
  /**
   * Name of the trigger function on the host (letters, digits, `_`, `-`).
   * @default `eventhub-<event hub logical ID>`
   */
  functionName?: string;
}

export type EventHubEventSourceService = <Req = never>(
  eventHub: EventHub,
  props: EventHubEventSourceProps,
  handler: (batch: EventHubBatch) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source connecting an {@link EventHub} to the runtime that hosts it.
 * Consume it with {@link consumeEvents} and provide the host's
 * implementation: `Azure.Functions.EventHubEventSource` (a native
 * `eventHubTrigger` function that reads in batches and checkpoints to the
 * host's storage).
 *
 * Event Hubs does not redeliver a batch whose handler failed: the
 * checkpoint moves on. Handle errors inside the handler.
 *
 * ### Consuming Events
 * **Example:** Sum readings per batch
 * ```typescript
 * yield* Azure.EventHub.consumeEvents(telemetry, (batch) =>
 *   Effect.log(`${batch.events.length} readings`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventHubEventSource)
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface EventHubEventSource extends Binding.Service<
  EventHubEventSource,
  "Azure.EventHub.EventHubEventSource",
  EventHubEventSourceService
> {}

export const EventHubEventSource = Binding.Service<EventHubEventSource>(
  "Azure.EventHub.EventHubEventSource",
);

/**
 * Run `handler` for each batch of events sent to `eventHub`.
 *
 * @example
 * ```typescript
 * yield* Azure.EventHub.consumeEvents(telemetry, (batch) => Effect.log(batch.events));
 * ```
 */
export function consumeEvents<H extends EventHub, Req = never, HubReq = never>(
  eventHub: H | Effect.Effect<H, never, HubReq>,
  handler: (batch: EventHubBatch) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, EventHubEventSource | HubReq>;
export function consumeEvents<H extends EventHub, Req = never, HubReq = never>(
  eventHub: H | Effect.Effect<H, never, HubReq>,
  props: EventHubEventSourceProps,
  handler: (batch: EventHubBatch) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, EventHubEventSource | HubReq>;
export function consumeEvents<H extends EventHub, Req = never, HubReq = never>(
  eventHub: H | Effect.Effect<H, never, HubReq>,
  propsOrHandler:
    | EventHubEventSourceProps
    | ((batch: EventHubBatch) => Effect.Effect<void, never, Req>),
  maybeHandler?: (batch: EventHubBatch) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, EventHubEventSource | HubReq> {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as EventHubEventSourceProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  const resolved = Effect.isEffect(eventHub) ? eventHub : Effect.succeed(eventHub);
  return resolved.pipe(
    Effect.flatMap((value) => EventHubEventSource.use((source) => source(value, props, handler))),
  );
}
