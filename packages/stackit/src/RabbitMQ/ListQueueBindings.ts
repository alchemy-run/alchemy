import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BrokerRequest } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";

export type ListQueueBindingsRequest = BrokerRequest<management.ListQueueBindingsRequest>;

/**
 * Runtime binding for the broker's management API `listQueueBindings`: list a queue's
 * bindings, including the default exchange's implicit one.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link ListQueueBindingsHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Listing Bindings
 * **Example:** List what feeds a queue from a Cloudflare Worker
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
 *     const listQueueBindings = yield* Stackit.RabbitMQ.ListQueueBindings(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bindings = yield* listQueueBindings({ queue: "jobs" });
 *         return yield* HttpServerResponse.json(bindings.map((binding) => binding.source));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ListQueueBindingsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface ListQueueBindings extends Binding.Service<
  ListQueueBindings,
  "Stackit.RabbitMQ.ListQueueBindings",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: ListQueueBindingsRequest,
    ) => Effect.Effect<
      management.ListQueueBindingsResponse,
      management.ListQueueBindingsError,
      RuntimeContext
    >
  >
> {}

export const ListQueueBindings = Binding.Service<ListQueueBindings>(
  "Stackit.RabbitMQ.ListQueueBindings",
);
