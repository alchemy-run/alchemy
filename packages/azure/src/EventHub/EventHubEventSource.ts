import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** One batch of events from one partition. */
export interface EventHubBatch {
  /** Event bodies, JSON-decoded when they are JSON. */
  events: unknown[];
  /** When Event Hubs accepted each event (UTC), in the order of `events`. */
  enqueuedTimesUtc: string[];
  /** Sequence number of each event in its partition, in the order of `events`. */
  sequenceNumbers: number[];
  /** All trigger metadata the host passed (`PartitionContext`, `PropertiesArray`, …). */
  metadata: Record<string, unknown>;
}

export interface EventHubEventSourceProps {
  /**
   * Name of the consumer group to read with, as a plain string. Give each
   * consumer its own group. `Basic` namespaces have only `$Default`.
   * @default "$Default"
   */
  consumerGroup?: string;
  /**
   * Name of the trigger function on the host: letters, digits, `_`, and
   * `-`, up to 128 characters. Set it when one host consumes the same hub
   * twice.
   * @default `eventhub-<event hub logical ID>`
   */
  functionName?: string;
}

/** What an {@link EventHubEventSource} layer implements: register `handler` for `eventHub` on the host. */
export type EventHubEventSourceService = <Req = never>(
  eventHub: EventHub,
  props: EventHubEventSourceProps,
  handler: (batch: EventHubBatch) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source connecting an {@link EventHub} to the runtime that hosts it:
 * run a handler for each batch of events sent to the hub. Consume it with
 * {@link consumeEvents} inside the host.
 *
 * Today only Azure Functions host it: provide
 * `Azure.Functions.EventHubEventSource`. It adds a native `eventHubTrigger`
 * function to the app that reads in batches, one partition at a time, and
 * checkpoints to the app's storage account. Binding assigns **Azure Event
 * Hubs Data Receiver** on the event hub only, to the app's managed
 * identity.
 *
 * :::caution[A failed batch is not redelivered]
 * The trigger moves the checkpoint on after the handler returns, whether
 * it succeeded or failed. Retry and log failures inside the handler. A
 * batch can be delivered twice after a host restart, so make the handler
 * idempotent.
 * :::
 *
 * ### Consuming Events
 * **Example:** Log each batch in a Function
 * ```typescript
 * // Readings: a module-scope Azure.EventHub.EventHub declaration
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: adds the trigger and assigns Data Receiver on the event hub only
 *     yield* Azure.EventHub.consumeEvents(Readings, (batch) =>
 *       // runtime: one call per batch
 *       Effect.log(`${batch.events.length} readings`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventHubEventSource)),
 * ) {}
 * ```
 *
 * ### Choosing a Consumer Group
 * Give each consumer of a hub its own consumer group, so each one reads
 * every event at its own pace.
 *
 * **Example:** Read with a dedicated consumer group
 * ```typescript
 * // init, inside the host above
 * const hub = yield* Readings;
 * yield* Azure.EventHub.ConsumerGroup("archiver", {
 *   namespace: hub.namespace,
 *   eventHub: hub.eventHubName,
 *   name: "archiver",
 * });
 * yield* Azure.EventHub.consumeEvents(
 *   Readings,
 *   { consumerGroup: "archiver", functionName: "archive-readings" },
 *   (batch) => Effect.log(batch.sequenceNumbers),
 * );
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
 * Run `handler` for each batch of events sent to `eventHub`, inside a host
 * that provides an {@link EventHubEventSource} layer
 * (`Azure.Functions.EventHubEventSource`). Pass `props` to pick the
 * consumer group or the trigger function's name.
 *
 * @example
 * ```typescript
 * // init, inside an Azure.Functions.Function
 * yield* Azure.EventHub.consumeEvents(Readings, (batch) => Effect.log(batch.events));
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
