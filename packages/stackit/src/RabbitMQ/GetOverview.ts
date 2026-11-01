import type * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface GetOverviewRequest extends management.GetOverviewRequest {}

/**
 * Runtime binding for the broker's management API `getOverview`: read what the broker
 * runs: versions, cluster name and totals.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetOverviewHttp}. It calls the broker's own management HTTP API with the
 * credential's user: binding it puts the credential's address, user and password in the
 * host's environment, with the secrets kept `Redacted`, and grants no STACKIT role. Keep
 * the host's egress IP in the instance's `acl`.
 *
 * ### Inspecting the Broker
 * **Example:** Report the broker's version from a Cloudflare Worker
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
 *     const getOverview = yield* Stackit.RabbitMQ.GetOverview(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const overview = yield* getOverview({});
 *         return yield* HttpServerResponse.json({ version: overview.rabbitmq_version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetOverviewHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetOverview extends Binding.Service<
  GetOverview,
  "Stackit.RabbitMQ.GetOverview",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request: GetOverviewRequest,
    ) => Effect.Effect<management.Overview, management.GetOverviewError, RuntimeContext>
  >
> {}

export const GetOverview = Binding.Service<GetOverview>("Stackit.RabbitMQ.GetOverview");
