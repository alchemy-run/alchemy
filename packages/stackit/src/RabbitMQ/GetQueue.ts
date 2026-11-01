import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type GetQueueRequest = BrokerRequest<management.GetQueueRequest>;

/**
 * Runtime binding for the broker's management API `getQueue`: read a queue's settings,
 * depth and consumer count. The broker samples the counts, so a new queue has none at
 * first.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetQueueHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Reading a Queue
 * **Example:** Report a queue's depth from a Cloudflare Worker
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
 *     const getQueue = yield* Stackit.RabbitMQ.GetQueue(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const queue = yield* getQueue({ queue: "jobs" });
 *         return yield* HttpServerResponse.json({ depth: queue.messages });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetQueueHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetQueue extends Binding.Service<
  GetQueue,
  "Stackit.RabbitMQ.GetQueue",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: GetQueueRequest,
    ) => Effect.Effect<management.Queue, management.GetQueueError, RuntimeContext>
  >
> {}

export const GetQueue = Binding.Service<GetQueue>("Stackit.RabbitMQ.GetQueue");
