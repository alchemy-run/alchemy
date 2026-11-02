import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetBackupRequest } from "./GetBackup.ts";
import type { GetDatabaseRequest } from "./GetDatabase.ts";
import type { GetInstanceRequest } from "./GetInstance.ts";
import type { GetUserRequest } from "./GetUser.ts";
import type { Instance } from "./Instance.ts";
import type { ListBackupsRequest } from "./ListBackups.ts";
import type { ListDatabasesRequest } from "./ListDatabases.ts";
import type { ListRestoreJobsRequest } from "./ListRestoreJobs.ts";
import type { ListUsersRequest } from "./ListUsers.ts";

/** The read operations on a bound instance. Its project, region and id are injected. */
export interface ReadInstanceClient {
  /** Read the instance's settings and state. */
  getInstance(
    request?: GetInstanceRequest,
  ): Effect.Effect<sqlserver.GetInstanceResponse, sqlserver.GetInstanceError, RuntimeContext>;
  /** List one page of the instance's databases. */
  listDatabases(
    request?: ListDatabasesRequest,
  ): Effect.Effect<sqlserver.ListDatabasesResponse, sqlserver.ListDatabasesError, RuntimeContext>;
  /** Read one database by name. */
  getDatabase(
    request: GetDatabaseRequest,
  ): Effect.Effect<sqlserver.GetDatabaseResponse, sqlserver.GetDatabaseError, RuntimeContext>;
  /** List one page of the instance's users. */
  listUsers(
    request?: ListUsersRequest,
  ): Effect.Effect<sqlserver.ListUserResponse, sqlserver.ListUsersError, RuntimeContext>;
  /** Read one user by id, without its password. */
  getUser(
    request: GetUserRequest,
  ): Effect.Effect<sqlserver.GetUserResponse, sqlserver.GetUserError, RuntimeContext>;
  /** List one page of the instance's backups, grouped per database. */
  listBackups(
    request?: ListBackupsRequest,
  ): Effect.Effect<sqlserver.ListBackupResponse, sqlserver.ListBackupsError, RuntimeContext>;
  /** Read one backup by id. */
  getBackup(
    request: GetBackupRequest,
  ): Effect.Effect<sqlserver.GetBackupResponse, sqlserver.GetBackupError, RuntimeContext>;
  /** List the restore jobs running on the instance. */
  listRestoreJobs(
    request?: ListRestoreJobsRequest,
  ): Effect.Effect<
    sqlserver.ListCurrentRunningRestoreJobsResponse,
    sqlserver.ListCurrentRunningRestoreJobsError,
    RuntimeContext
  >;
}

/**
 * Read an {@link Instance}, its databases, users, backups and restore jobs from a
 * Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the eight read permissions (`sqlserver-flex.instance.get`, `sqlserver-flex.database.list`, `sqlserver-flex.database.get`, `sqlserver-flex.user.list`, `sqlserver-flex.user.get`, `sqlserver-flex.backup.list`, `sqlserver-flex.backup.get`, `sqlserver-flex.restore.list`), bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so they reach
 * every SQL Server Flex instance in that project.
 *
 * ### Reading an Instance
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
 *     const client = yield* Stackit.SQLServerFlex.ReadInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users } = yield* client.listUsers();
 *         return yield* HttpServerResponse.json({ count: users.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface ReadInstance extends Binding.Service<
  ReadInstance,
  "Stackit.SQLServerFlex.ReadInstance",
  (instance: Instance) => Effect.Effect<ReadInstanceClient>
> {}

export const ReadInstance = Binding.Service<ReadInstance>("Stackit.SQLServerFlex.ReadInstance");
