import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetCredentialRequest extends Omit<
  rabbitmq.GetCredentialsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `getCredentials`: read one credential, with its user
 * and connection details. The password and URIs come back `Redacted`.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetCredentialHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.credential.get`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Reading a Credential
 * **Example:** Read a credential's user from a Cloudflare Worker
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
 *     const getCredential = yield* Stackit.RabbitMQ.GetCredential(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const credential = yield* getCredential({ credentialsId: "..." });
 *         return yield* HttpServerResponse.json({ user: credential.raw?.credentials.username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetCredentialHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetCredential extends Binding.Service<
  GetCredential,
  "Stackit.RabbitMQ.GetCredential",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetCredentialRequest,
    ) => Effect.Effect<rabbitmq.CredentialsResponse, rabbitmq.GetCredentialsError, RuntimeContext>
  >
> {}

export const GetCredential = Binding.Service<GetCredential>("Stackit.RabbitMQ.GetCredential");
