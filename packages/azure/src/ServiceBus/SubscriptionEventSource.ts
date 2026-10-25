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
 * Event source connecting a Service Bus topic {@link Subscription} to the
 * runtime that hosts it. Consume it with {@link consumeSubscriptionMessages}
 * and provide the host's implementation:
 * `Azure.Functions.ServiceBusSubscriptionEventSource` (a native
 * `serviceBusTrigger` function on the topic and subscription).
 *
 * ### Consuming a Topic Subscription
 * **Example:** Audit every published event
 * ```typescript
 * const audit = yield* Azure.ServiceBus.Subscription("Audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.consumeSubscriptionMessages(audit, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.Functions.ServiceBusSubscriptionEventSource)
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
