import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ResetUserRequest } from "./ResetUser.ts";
import type { RestoreDatabaseFromBackupRequest } from "./RestoreDatabaseFromBackup.ts";
import type { TriggerBackupRequest } from "./TriggerBackup.ts";
import type { TriggerRestoreRequest } from "./TriggerRestore.ts";

/** The write operations on a bound instance. Its project, region and id are injected. */
export interface WriteInstanceClient {
  /** Reset a user's password and get the new one, `Redacted`. */
  resetUser(
    request: ResetUserRequest,
  ): Effect.Effect<sqlserver.ResetUserResponse, sqlserver.ResetUserError, RuntimeContext>;
  /** Start a backup of one database. */
  triggerBackup(
    request: TriggerBackupRequest,
  ): Effect.Effect<sqlserver.TriggerBackupResponse, sqlserver.TriggerBackupError, RuntimeContext>;
  /** Restore one database to a point in time. */
  triggerRestore(
    request: TriggerRestoreRequest,
  ): Effect.Effect<sqlserver.TriggerRestoreResponse, sqlserver.TriggerRestoreError, RuntimeContext>;
  /** Restore a database from a managed backup or external S3 files. */
  restoreDatabaseFromBackup(
    request: RestoreDatabaseFromBackupRequest,
  ): Effect.Effect<
    sqlserver.RestoreDatabaseFromBackupResponse,
    sqlserver.RestoreDatabaseFromBackupError,
    RuntimeContext
  >;
}

/**
 * Rotate an {@link Instance}'s passwords and start its backups and restores from a
 * Function/Worker. Settings, users and databases belong to the stack.
 *
 * Bind it in the init phase and provide {@link WriteInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permissions `sqlserver-flex.user.reset`,
 * `sqlserver-flex.backup.trigger` and `sqlserver-flex.restore.trigger`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so they
 * reach every SQL Server Flex instance in that project.
 *
 * ### Starting a Backup
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
 *     const client = yield* Stackit.SQLServerFlex.WriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* client.triggerBackup({ databaseName: "orders" });
 *         return yield* HttpServerResponse.json({ started: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface WriteInstance extends Binding.Service<
  WriteInstance,
  "Stackit.SQLServerFlex.WriteInstance",
  (instance: Instance) => Effect.Effect<WriteInstanceClient>
> {}

export const WriteInstance = Binding.Service<WriteInstance>("Stackit.SQLServerFlex.WriteInstance");
