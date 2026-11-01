import type * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateBackupRequest extends Omit<
  opensearch.CreateBackupRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT OpenSearch `createBackup`: start an on-demand backup of
 * the instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `opensearch.proxy.write`, bound on
 * the project holding the instance. STACKIT binds roles on projects at the narrowest,
 * so the permission reaches every STACKIT OpenSearch instance in that project. STACKIT
 * gates backups, metrics, restarts and updates behind this one permission, so it allows
 * all of the changes in that group.
 *
 * ### Calling `createBackup`
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
 *     const createBackup = yield* Stackit.OpenSearch.CreateBackup(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* createBackup({});
 *         return yield* HttpServerResponse.json({ backup });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.CreateBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "Stackit.OpenSearch.CreateBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateBackupRequest,
    ) => Effect.Effect<
      opensearch.CreateBackupResponseItem,
      opensearch.CreateBackupError,
      RuntimeContext
    >
  >
> {}

export const CreateBackup = Binding.Service<CreateBackup>("Stackit.OpenSearch.CreateBackup");
