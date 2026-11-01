import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface RestoreDatabaseFromBackupRequest extends Omit<
  sqlserver.RestoreDatabaseFromBackupRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for SQL Server Flex `restoreDatabaseFromBackup`: restore a database from a managed backup, or from `.bak` files in an external S3 bucket.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link RestoreDatabaseFromBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * S3 credentials in the request stay `Redacted`.
 *
 * Access: a custom role with the single permission `sqlserver-flex.restore.trigger`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every SQL Server Flex instance in that project.
 *
 * ### Calling `restoreDatabaseFromBackup`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Db;
 *     const restoreDatabaseFromBackup = yield* Stackit.SQLServerFlex.RestoreDatabaseFromBackup(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restoreDatabaseFromBackup({
 *           database_name: "orders",
 *           source: { type: "BACKUP" },
 *         });
 *         return yield* HttpServerResponse.json({ started: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.RestoreDatabaseFromBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface RestoreDatabaseFromBackup extends Binding.Service<
  RestoreDatabaseFromBackup,
  "Stackit.SQLServerFlex.RestoreDatabaseFromBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: RestoreDatabaseFromBackupRequest,
    ) => Effect.Effect<
      sqlserver.RestoreDatabaseFromBackupResponse,
      sqlserver.RestoreDatabaseFromBackupError,
      RuntimeContext
    >
  >
> {}

export const RestoreDatabaseFromBackup = Binding.Service<RestoreDatabaseFromBackup>(
  "Stackit.SQLServerFlex.RestoreDatabaseFromBackup",
);
