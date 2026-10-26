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

/** Where the events come from and which ones the handler gets. */
export interface EventGridEventSourceProps {
  /**
   * ARM ID of the event source: an `Azure.EventGrid.Topic` (`topic.topicId`),
   * a storage account (`account.storageAccountId`), a resource group, a Key
   * Vault, or any other resource that publishes Event Grid events. Alchemy
   * creates the event subscription on this scope. Changing it deletes the
   * subscription on the old scope and creates one on the new scope.
   */
  scope: Input<string>;
  /**
   * Event types to deliver, e.g. `["Microsoft.Storage.BlobCreated"]`.
   * @default every type the source emits
   */
  includedEventTypes?: string[];
  /**
   * Deliver only events whose subject starts with this prefix, e.g.
   * `/blobServices/default/containers/uploads/`.
   * @default no prefix filter
   */
  subjectBeginsWith?: Input<string>;
  /**
   * Deliver only events whose subject ends with this suffix, e.g. `.png`.
   * @default no suffix filter
   */
  subjectEndsWith?: Input<string>;
}

/**
 * The `EventGridEventSource` service: subscribes `handler` to the events of
 * `props.scope` under `name`. Call it through {@link consumeEvents}.
 */
export type EventGridEventSourceService = <Req = never>(
  name: string,
  props: EventGridEventSourceProps,
  handler: (event: EventGridEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source that runs a handler for Event Grid events from any source: a
 * custom topic, a storage account, a resource group, a Key Vault, and other
 * Azure resources that publish events. Consume it with
 * {@link consumeEvents} inside the host and provide the host's layer.
 *
 * On an Azure Function, provide `Azure.Functions.EventGridEventSource`.
 * Each `consumeEvents` call adds a native `eventGridTrigger` function to
 * the app and an Event Grid subscription on `scope` that pushes to it
 * (destination type `AzureFunction`, Event Grid schema, one event per
 * invocation). Alchemy creates the subscription after the code is deployed
 * and deletes it with the Function. No role is assigned: Event Grid
 * delivers to the function directly.
 *
 * Event Grid retries a failed delivery with backoff for up to 24 hours.
 *
 * :::caution
 * Alchemy registers the `Microsoft.EventGrid` resource provider on the
 * subscription before it creates the first event subscription. The
 * deploying identity needs permission to register resource providers.
 * :::
 *
 * ### Subscribing to Events
 * **Example:** React to events on a custom topic
 * ```typescript
 * const Orders = Azure.EventGrid.Topic("Orders", {});
 *
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     // init: adds an eventGridTrigger function and a subscription on the topic
 *     yield* Azure.EventGrid.consumeEvents(
 *       "OrderEvents",
 *       { scope: topic.topicId, includedEventTypes: ["Order.Created"] },
 *       // runtime: one call per event
 *       (event) => Effect.log(`${event.eventType} ${event.subject}`),
 *     );
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
 * ```
 *
 * ### Filtering Events
 * **Example:** React to new `.png` blobs in one container of a storage account
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Thumbnails extends Azure.Functions.Function<Thumbnails>()(
 *   "Thumbnails",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     yield* Azure.EventGrid.consumeEvents(
 *       "NewImages",
 *       {
 *         scope: account.storageAccountId,
 *         includedEventTypes: ["Microsoft.Storage.BlobCreated"],
 *         subjectBeginsWith: "/blobServices/default/containers/uploads/",
 *         subjectEndsWith: ".png",
 *       },
 *       (event) => Effect.log(`new image: ${event.subject}`),
 *     );
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
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
 * identifies the subscription and the trigger function (`eventgrid-<name>`),
 * so keep it unique in the host; use letters, digits, and hyphens.
 *
 * @example
 * ```typescript
 * // inside the Function's init, with Azure.Functions.EventGridEventSource provided
 * const topic = yield* Orders;
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
