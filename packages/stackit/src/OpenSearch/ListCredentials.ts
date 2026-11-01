import type * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListCredentialsRequest extends Omit<
  opensearch.ListCredentialsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT OpenSearch `listCredentials`: list the ids of the
 * instance's credentials.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListCredentialsHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `opensearch.credential.list`, bound
 * on the project holding the instance. STACKIT binds roles on projects at the
 * narrowest, so the permission reaches every STACKIT OpenSearch instance in that
 * project.
 *
 * ### Calling `listCredentials`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Search = Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Search;
 *     const listCredentials = yield* Stackit.OpenSearch.ListCredentials(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credentialsList } = yield* listCredentials({});
 *         return yield* HttpServerResponse.json({ count: credentialsList.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.OpenSearch.ListCredentials",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListCredentialsRequest,
    ) => Effect.Effect<
      opensearch.ListCredentialsResponse,
      opensearch.ListCredentialsError,
      RuntimeContext
    >
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>(
  "Stackit.OpenSearch.ListCredentials",
);
