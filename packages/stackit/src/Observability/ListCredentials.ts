import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListCredentialsRequest extends Omit<
  observability.ListCredentialsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listCredentials`: list an instance's credentials,
 * without their passwords.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListCredentialsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * `credentialsInfo` is an open map, and no STACKIT source says what it holds. Treat it
 * as secret and don't pass it on.
 *
 * ### Listing Credentials
 * **Example:** List the usernames from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const listCredentials = yield* Stackit.Observability.ListCredentials(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listCredentials();
 *         return yield* HttpServerResponse.json({
 *           usernames: live.credentials.map((credential) => credential.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.Observability.ListCredentials",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListCredentialsRequest,
    ) => Effect.Effect<
      observability.ListCredentialsResponse,
      observability.ListCredentialsError,
      RuntimeContext
    >
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>(
  "Stackit.Observability.ListCredentials",
);
