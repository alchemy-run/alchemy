import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type GetExchangeRequest = BrokerRequest<management.GetExchangeRequest>;

/**
 * Runtime binding for the broker's management API `getExchange`: read an exchange's
 * settings.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetExchangeHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Reading an Exchange
 * **Example:** Read an exchange's type from a Cloudflare Worker
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
 *     const getExchange = yield* Stackit.RabbitMQ.GetExchange(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const exchange = yield* getExchange({ exchange: "events" });
 *         return yield* HttpServerResponse.json({ type: exchange.type });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetExchangeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetExchange extends Binding.Service<
  GetExchange,
  "Stackit.RabbitMQ.GetExchange",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: GetExchangeRequest,
    ) => Effect.Effect<management.Exchange, management.GetExchangeError, RuntimeContext>
  >
> {}

export const GetExchange = Binding.Service<GetExchange>("Stackit.RabbitMQ.GetExchange");
