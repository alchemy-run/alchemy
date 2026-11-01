import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type BindQueueRequest = BrokerRequest<management.CreateQueueBindingRequest>;

/**
 * Runtime binding for the broker's management API `createQueueBinding`: bind a queue
 * to an exchange with a routing key.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link BindQueueHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Binding a Queue
 * **Example:** Bind a queue to an exchange from a Cloudflare Worker
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
 *     const bindQueue = yield* Stackit.RabbitMQ.BindQueue(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* bindQueue({ exchange: "events", queue: "jobs", routing_key: "order.*" });
 *         return yield* HttpServerResponse.json({ bound: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.BindQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface BindQueue extends Binding.Service<
  BindQueue,
  "Stackit.RabbitMQ.BindQueue",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: BindQueueRequest,
    ) => Effect.Effect<
      management.CreateQueueBindingResponse,
      management.CreateQueueBindingError,
      RuntimeContext
    >
  >
> {}

export const BindQueue = Binding.Service<BindQueue>("Stackit.RabbitMQ.BindQueue");
