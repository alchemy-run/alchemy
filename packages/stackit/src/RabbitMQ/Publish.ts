import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface PublishRequest {
  /**
   * Exchange to publish to.
   * @default the default exchange, which routes `routing_key` to the queue of that name
   */
  exchange?: string;
  /** Routing key: with the default exchange, the name of the queue. */
  routing_key: string;
  /** Message body. */
  payload: string;
  /**
   * How `payload` is encoded: `string` for UTF-8 text, `base64` for bytes.
   * @default "string"
   */
  payload_encoding?: "string" | "base64";
  /**
   * AMQP message properties, in the broker's names: `content_type`, `delivery_mode`
   * (`2` to persist), `headers`, `message_id`, ...
   * @default {}
   */
  properties?: management.PublishMessageRequestPropertiesMap;
  /**
   * Virtual host.
   * @default the one in the credential's AMQP URI, or `/` when it names none
   */
  vhost?: string;
}

/**
 * Runtime binding to publish one message to the broker, through its management API's
 * `publishMessage`.
 *
 * This takes an HTTPS request, not an AMQP connection, so it runs on any host,
 * including Functions and Workers that hold no socket between requests. RabbitMQ notes
 * the route isn't made for high throughput: a host publishing thousands of messages a
 * second should open AMQP with `Stackit.RabbitMQ.Connect`. The answer's `routed` says
 * whether at least one queue took the message; a message nothing routes is dropped
 * without an error.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link PublishHttp}. It calls the broker with the credential's user: binding
 * it puts the credential's address, user and password in the host's environment, with
 * the secrets kept `Redacted`, and grants no STACKIT role. Keep the host's egress IP in
 * the instance's `acl`.
 *
 * ### Publishing a Message
 * **Example:** Publish to a queue from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 * export const App = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("App", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const publish = yield* Stackit.RabbitMQ.Publish(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { routed } = yield* publish({
 *           routing_key: "jobs",
 *           payload: JSON.stringify({ id: 1 }),
 *           properties: { content_type: "application/json", delivery_mode: 2 },
 *         });
 *         return yield* HttpServerResponse.json({ routed });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.PublishHttp)),
 * ) {}
 * ```
 *
 * ### Publishing to an Exchange
 * **Example:** Publish an event to a topic exchange
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 * export const App = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("App", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const publish = yield* Stackit.RabbitMQ.Publish(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { routed } = yield* publish({
 *           exchange: "events",
 *           routing_key: "order.created",
 *           payload: "1234",
 *         });
 *         return yield* HttpServerResponse.json({ routed });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.PublishHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface Publish extends Binding.Service<
  Publish,
  "Stackit.RabbitMQ.Publish",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<
      management.PublishMessageResponse,
      management.PublishMessageError,
      RuntimeContext
    >
  >
> {}

export const Publish = Binding.Service<Publish>("Stackit.RabbitMQ.Publish");
