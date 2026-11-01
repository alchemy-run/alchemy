import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type DeleteExchangeRequest = BrokerRequest<management.DeleteExchangeRequest>;

/**
 * Runtime binding for the broker's management API `deleteExchange`: delete an exchange.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link DeleteExchangeHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Deleting an Exchange
 * **Example:** Delete an exchange from a Cloudflare Worker
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
 *     const deleteExchange = yield* Stackit.RabbitMQ.DeleteExchange(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteExchange({ exchange: "events" });
 *         return yield* HttpServerResponse.json({ deleted: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.DeleteExchangeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface DeleteExchange extends Binding.Service<
  DeleteExchange,
  "Stackit.RabbitMQ.DeleteExchange",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: DeleteExchangeRequest,
    ) => Effect.Effect<
      management.DeleteExchangeResponse,
      management.DeleteExchangeError,
      RuntimeContext
    >
  >
> {}

export const DeleteExchange = Binding.Service<DeleteExchange>("Stackit.RabbitMQ.DeleteExchange");
