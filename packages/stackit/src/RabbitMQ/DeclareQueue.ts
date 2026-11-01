import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type DeclareQueueRequest = BrokerRequest<management.PutQueueRequest>;

/**
 * Runtime binding for the broker's management API `putQueue`: declare a queue.
 * Declaring it again with the same settings does nothing, and different settings fail
 * with `InequivalentArguments`.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link DeclareQueueHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Declaring a Queue
 * **Example:** Declare a durable queue from a Cloudflare Worker
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
 *     const declareQueue = yield* Stackit.RabbitMQ.DeclareQueue(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* declareQueue({ queue: "jobs", durable: true });
 *         return yield* HttpServerResponse.json({ declared: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.DeclareQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface DeclareQueue extends Binding.Service<
  DeclareQueue,
  "Stackit.RabbitMQ.DeclareQueue",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: DeclareQueueRequest,
    ) => Effect.Effect<management.PutQueueResponse, management.PutQueueError, RuntimeContext>
  >
> {}

export const DeclareQueue = Binding.Service<DeclareQueue>("Stackit.RabbitMQ.DeclareQueue");
