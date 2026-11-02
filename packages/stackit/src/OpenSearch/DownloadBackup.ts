import type * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DownloadBackupRequest extends Omit<
  opensearch.DownloadBackupRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT OpenSearch `downloadBackup`: download a backup of the
 * instance as bytes, read into memory in one piece.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DownloadBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `opensearch.proxy.read`, bound on
 * the project holding the instance. STACKIT binds roles on projects at the narrowest,
 * so the permission reaches every STACKIT OpenSearch instance in that project. STACKIT
 * gates backups, metrics, restarts and updates behind this one permission, so it allows
 * all of the reads in that group.
 *
 * ### Calling `downloadBackup`
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
 *     const downloadBackup = yield* Stackit.OpenSearch.DownloadBackup(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const archive = yield* downloadBackup({ backupId: 1 });
 *         return yield* HttpServerResponse.json({ size: archive.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.DownloadBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category OpenSearch
 */
export interface DownloadBackup extends Binding.Service<
  DownloadBackup,
  "Stackit.OpenSearch.DownloadBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DownloadBackupRequest,
    ) => Effect.Effect<opensearch.BackupArchive, opensearch.DownloadBackupError, RuntimeContext>
  >
> {}

export const DownloadBackup = Binding.Service<DownloadBackup>("Stackit.OpenSearch.DownloadBackup");
