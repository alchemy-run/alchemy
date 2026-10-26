import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { ServiceBusEventSourceProps, ServiceBusMessage } from "./QueueEventSource.ts";
import type { Subscription } from "./Subscription.ts";

export type SubscriptionEventSourceService = <Req = never>(
  subscription: Subscription,
  props: ServiceBusEventSourceProps,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Run a handler for every message an Azure Service Bus topic delivers to a
 * {@link Subscription}. Consume it with {@link consumeSubscriptionMessages}
 * inside the host and provide the host's layer:
 *
 * - **Azure Function**: `Azure.Functions.ServiceBusSubscriptionEventSource`.
 *   It adds a native `serviceBusTrigger` function on the topic and
 *   subscription and assigns **Azure Service Bus Data Receiver** on the
 *   subscription only.
 * - **Container App**:
 *   `Azure.ContainerApps.AppServiceBusSubscriptionEventSource`. It adds a
 *   KEDA `azure-servicebus` scale rule and runs a receive loop in every
 *   replica. It assigns **Azure Service Bus Data Owner** on the
 *   subscription only, because the KEDA scaler reads its message count.
 *
 * The host completes a message when the handler succeeds and abandons it
 * when the handler fails (defects). After the subscription's max delivery
 * count the message moves to the subscription's dead-letter queue. Each
 * subscription gets its own copy of every message its rules match.
 *
 * ### Consuming a Topic Subscription
 * **Example:** Audit every published event in an Azure Function
 * ```typescript
 * export const Audit = Effect.gen(function* () {
 *   const bus = yield* Bus;
 *   const events = yield* Events;
 *   return yield* Azure.ServiceBus.Subscription("Audit", {
 *     namespace: bus.namespaceName,
 *     topic: events.topicName,
 *   });
 * });
 *
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: adds the trigger and assigns the role on the subscription only
 *     yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
 *       // runtime: once per message
 *       Effect.log(`event ${message.messageId}: ${JSON.stringify(message.body)}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.ServiceBusSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Audit events in a Container App
 * ```typescript
 * export default class Auditor extends Azure.ContainerApps.ContainerApp<Auditor>()(
 *   "Auditor",
 *   Effect.gen(function* () {
 *     const env = yield* Environment;
 *     return { main: import.meta.url, environmentId: env.environmentId };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
 *       Effect.log(`event ${message.messageId}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerApps.AppServiceBusSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface SubscriptionEventSource extends Binding.Service<
  SubscriptionEventSource,
  "Azure.ServiceBus.SubscriptionEventSource",
  SubscriptionEventSourceService
> {}

export const SubscriptionEventSource = Binding.Service<SubscriptionEventSource>(
  "Azure.ServiceBus.SubscriptionEventSource",
);

/**
 * Run `handler` for every message the topic delivers to `subscription`.
 *
 * @example
 * ```typescript
 * yield* Azure.ServiceBus.consumeSubscriptionMessages(audit, (message) => Effect.log(message.body));
 * ```
 */
export function consumeSubscriptionMessages<
  S extends Subscription,
  Req = never,
  SubscriptionReq = never,
>(
  subscription: S | Effect.Effect<S, never, SubscriptionReq>,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, SubscriptionEventSource | SubscriptionReq>;
export function consumeSubscriptionMessages<
  S extends Subscription,
  Req = never,
  SubscriptionReq = never,
>(
  subscription: S | Effect.Effect<S, never, SubscriptionReq>,
  props: ServiceBusEventSourceProps,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, SubscriptionEventSource | SubscriptionReq>;
export function consumeSubscriptionMessages<
  S extends Subscription,
  Req = never,
  SubscriptionReq = never,
>(
  subscription: S | Effect.Effect<S, never, SubscriptionReq>,
  propsOrHandler:
    | ServiceBusEventSourceProps
    | ((message: ServiceBusMessage) => Effect.Effect<void, never, Req>),
  maybeHandler?: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, SubscriptionEventSource | SubscriptionReq> {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as ServiceBusEventSourceProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  const resolved = Effect.isEffect(subscription) ? subscription : Effect.succeed(subscription);
  return resolved.pipe(
    Effect.flatMap((value) =>
      SubscriptionEventSource.use((source) => source(value, props, handler)),
    ),
  );
}
