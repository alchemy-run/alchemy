import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListCredentialsRequest extends Omit<
  rabbitmq.ListCredentialsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `listCredentials`: list the ids of an instance's
 * credentials.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListCredentialsHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.credential.list`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Listing Credentials
 * **Example:** List the credentials from a Cloudflare Worker
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
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const broker = yield* Broker;
 *     const listCredentials = yield* Stackit.RabbitMQ.ListCredentials(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credentialsList } = yield* listCredentials({});
 *         return yield* HttpServerResponse.json({ count: credentialsList.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.RabbitMQ.ListCredentials",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListCredentialsRequest,
    ) => Effect.Effect<
      rabbitmq.ListCredentialsResponse,
      rabbitmq.ListCredentialsError,
      RuntimeContext
    >
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>("Stackit.RabbitMQ.ListCredentials");
