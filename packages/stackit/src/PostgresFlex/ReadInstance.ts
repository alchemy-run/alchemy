import type * as postgres from "@distilled.cloud/stackit/postgres_flex";
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
import type { ListUsersRequest } from "./ListUsers.ts";

/** The read operations on a bound instance. Its project, region and id are injected. */
export interface ReadInstanceClient {
  /** Read the instance's settings, state and connection endpoint. */
  getInstance(
    request?: GetInstanceRequest,
  ): Effect.Effect<postgres.GetInstanceResponse, postgres.GetInstanceError, RuntimeContext>;
  /** List one page of the instance's databases. */
  listDatabases(
    request?: ListDatabasesRequest,
  ): Effect.Effect<postgres.ListDatabasesResponse, postgres.ListDatabasesError, RuntimeContext>;
  /** Read one database by id. */
  getDatabase(
    request: GetDatabaseRequest,
  ): Effect.Effect<postgres.GetDatabaseResponse, postgres.GetDatabaseError, RuntimeContext>;
  /** List one page of the instance's users. */
  listUsers(
    request?: ListUsersRequest,
  ): Effect.Effect<postgres.ListUsersResponse, postgres.ListUsersError, RuntimeContext>;
  /** Read one user by id. */
  getUser(
    request: GetUserRequest,
  ): Effect.Effect<postgres.GetUserResponse, postgres.GetUserError, RuntimeContext>;
  /** List one page of the instance's backups. */
  listBackups(
    request?: ListBackupsRequest,
  ): Effect.Effect<postgres.ListBackupsResponse, postgres.ListBackupsError, RuntimeContext>;
  /** Read one backup by id. */
  getBackup(
    request: GetBackupRequest,
  ): Effect.Effect<postgres.BackupData, postgres.GetBackupError, RuntimeContext>;
}

/**
 * Read an {@link Instance}, its databases, users and backups from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the seven read permissions (`postgres-flex.instance.get`,
 * `postgres-flex.database.list`, `postgres-flex.database.get`, `postgres-flex.user.list`,
 * `postgres-flex.user.get`, `postgres-flex.backup.list`, `postgres-flex.backup.get`),
 * bound on the project holding the instance. STACKIT binds roles on projects at the
 * narrowest, so they reach every PostgreSQL Flex instance in that project.
 *
 * ### Reading an Instance
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
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
 *     const client = yield* Stackit.PostgresFlex.ReadInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users } = yield* client.listUsers();
 *         return yield* HttpServerResponse.json({ count: users.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PostgresFlex
 */
export interface ReadInstance extends Binding.Service<
  ReadInstance,
  "Stackit.PostgresFlex.ReadInstance",
  (instance: Instance) => Effect.Effect<ReadInstanceClient>
> {}

export const ReadInstance = Binding.Service<ReadInstance>("Stackit.PostgresFlex.ReadInstance");
