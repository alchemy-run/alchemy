import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type DeclareExchangeRequest = BrokerRequest<management.PutExchangeRequest>;

/**
 * Runtime binding for the broker's management API `putExchange`: declare an exchange.
 * Declaring it again with the same settings does nothing, and different settings fail
 * with `InequivalentArguments`.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link DeclareExchangeHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Declaring an Exchange
 * **Example:** Declare a topic exchange from a Cloudflare Worker
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
 *     const declareExchange = yield* Stackit.RabbitMQ.DeclareExchange(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* declareExchange({ exchange: "events", type: "topic", durable: true });
 *         return yield* HttpServerResponse.json({ declared: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.DeclareExchangeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface DeclareExchange extends Binding.Service<
  DeclareExchange,
  "Stackit.RabbitMQ.DeclareExchange",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: DeclareExchangeRequest,
    ) => Effect.Effect<management.PutExchangeResponse, management.PutExchangeError, RuntimeContext>
  >
> {}

export const DeclareExchange = Binding.Service<DeclareExchange>("Stackit.RabbitMQ.DeclareExchange");
