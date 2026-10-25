import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";

/** One Event Grid event (Event Grid schema). */
export interface EventGridEvent {
  /** Event ID. */
  id: string;
  /** Event type, e.g. `Microsoft.Storage.BlobCreated`. */
  eventType: string;
  /** Publisher-defined subject, e.g. `/blobServices/default/containers/c/blobs/b`. */
  subject: string;
  /** When the event happened. */
  eventTime: string;
  /** ARM ID of the topic the event came through. */
  topic: string | undefined;
  /** Event payload. */
  data: unknown;
  /** Schema version of `data`. */
  dataVersion: string | undefined;
}

export interface EventGridEventSourceProps {
  /**
   * ARM ID of the event source: an `EventGrid.Topic`, a storage account, a
   * resource group, a Key Vault, … Changing it moves the subscription.
   */
  scope: Input<string>;
  /** Event types to deliver. @default every type the source emits */
  includedEventTypes?: string[];
  /** Deliver only events whose subject starts with this prefix. */
  subjectBeginsWith?: Input<string>;
  /** Deliver only events whose subject ends with this suffix. */
  subjectEndsWith?: Input<string>;
}

export type EventGridEventSourceService = <Req = never>(
  name: string,
  props: EventGridEventSourceProps,
  handler: (event: EventGridEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source that subscribes the runtime to Event Grid events from any
 * source (a custom topic, a storage account, a resource group, …).
 * Consume it with {@link consumeEvents} and provide the host's
 * implementation: `Azure.Functions.EventGridEventSource` (an Event Grid
 * subscription that pushes to a native `eventGridTrigger` function).
 *
 * Event Grid retries a failed delivery with backoff for up to 24 hours.
 *
 * ### Subscribing to Events
 * **Example:** React to events on a custom topic
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("Orders");
 * yield* Azure.EventGrid.consumeEvents(
 *   "OrderEvents",
 *   { scope: topic.topicId, includedEventTypes: ["Contoso.Order.Created"] },
 *   (event) => Effect.log(`${event.eventType} ${event.subject}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * **Example:** React to storage account events
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "Deletes",
 *   { scope: account.storageAccountId, includedEventTypes: ["Microsoft.Storage.BlobDeleted"] },
 *   (event) => Effect.log(event.subject),
 * );
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface EventGridEventSource extends Binding.Service<
  EventGridEventSource,
  "Azure.EventGrid.EventGridEventSource",
  EventGridEventSourceService
> {}

export const EventGridEventSource = Binding.Service<EventGridEventSource>(
  "Azure.EventGrid.EventGridEventSource",
);

/**
 * Run `handler` for every Event Grid event from `props.scope`. `name`
 * identifies the subscription and the trigger function (letters, digits,
 * hyphens).
 *
 * @example
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents("Audit", { scope: topic.topicId }, (event) =>
 *   Effect.log(event.eventType),
 * );
 * ```
 */
export const consumeEvents = <Req = never>(
  name: string,
  props: EventGridEventSourceProps,
  handler: (event: EventGridEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, EventGridEventSource> =>
  EventGridEventSource.use((source) => source(name, props, handler));
