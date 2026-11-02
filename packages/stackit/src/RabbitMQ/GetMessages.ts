import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type GetMessagesRequest = BrokerRequest<management.GetMessagesRequest>;

/**
 * Runtime binding for the broker's management API `getMessages`: fetch messages from a
 * queue. RabbitMQ documents this route as a diagnostics tool without reliable
 * delivery: use `Stackit.RabbitMQ.Consume` to process a queue.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetMessagesHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Peeking at a Queue
 * **Example:** Peek at a queue's next message from a Cloudflare Worker
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
 *     const getMessages = yield* Stackit.RabbitMQ.GetMessages(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const messages = yield* getMessages({
 *           queue: "jobs",
 *           count: 1,
 *           ackmode: "ack_requeue_true",
 *           encoding: "auto",
 *         });
 *         return yield* HttpServerResponse.json({ next: messages[0]?.payload });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetMessagesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetMessages extends Binding.Service<
  GetMessages,
  "Stackit.RabbitMQ.GetMessages",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: GetMessagesRequest,
    ) => Effect.Effect<management.GetMessagesResponse, management.GetMessagesError, RuntimeContext>
  >
> {}

export const GetMessages = Binding.Service<GetMessages>("Stackit.RabbitMQ.GetMessages");
