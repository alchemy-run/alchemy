import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { WriteServiceBusTopicClient } from "./ServiceBusTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * Publish messages, one at a time or in batches, to an Azure Service Bus
 * topic from any host. Every subscription whose rules match gets a copy;
 * read them with {@link SubscriptionRead}. A topic has no receive side, so
 * there is no `TopicRead`.
 *
 * Binding assigns **Azure Service Bus Data Sender**
 * (the `send/action` data action) on the topic only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link TopicWriteHttp}.
 *
 * ### Publishing Events
 * **Example:** Publish an event with a label subscribers filter on
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Events;
 *     const events = yield* Azure.ServiceBus.TopicWrite(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* events.send({ type: "order.created", orderId: "42" }, { label: "order" });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.TopicWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface TopicWrite extends Binding.Service<
  TopicWrite,
  "Azure.ServiceBus.TopicWrite",
  (topic: Topic) => Effect.Effect<WriteServiceBusTopicClient>
> {}

export const TopicWrite = Binding.Service<TopicWrite>("Azure.ServiceBus.TopicWrite");
