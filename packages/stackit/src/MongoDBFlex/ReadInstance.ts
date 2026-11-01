import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetBackupRequest } from "./GetBackup.ts";
import type { GetInstanceRequest } from "./GetInstance.ts";
import type { GetUserRequest } from "./GetUser.ts";
import type { Instance } from "./Instance.ts";
import type { ListAdvisorSlowQueriesRequest } from "./ListAdvisorSlowQueries.ts";
import type { ListBackupsRequest } from "./ListBackups.ts";
import type { ListMetricsRequest } from "./ListMetrics.ts";
import type { ListRestoreJobsRequest } from "./ListRestoreJobs.ts";
import type { ListSuggestedIndexesRequest } from "./ListSuggestedIndexes.ts";
import type { ListUsersRequest } from "./ListUsers.ts";

/** The read operations on a bound instance. Its project, region and id are injected. */
export interface ReadInstanceClient {
  /** Read the instance's settings and status. */
  getInstance(
    request?: GetInstanceRequest,
  ): Effect.Effect<mongodb.InstanceResponse, mongodb.GetInstanceError, RuntimeContext>;
  /** List the instance's users: their ids and names. */
  listUsers(
    request?: ListUsersRequest,
  ): Effect.Effect<mongodb.ListUsersResponse, mongodb.ListUsersError, RuntimeContext>;
  /** Read one user by id, never its password. */
  getUser(
    request: GetUserRequest,
  ): Effect.Effect<mongodb.GetUserResponse, mongodb.GetUserError, RuntimeContext>;
  /** List the instance's backups. */
  listBackups(
    request?: ListBackupsRequest,
  ): Effect.Effect<mongodb.ListBackupsResponse, mongodb.ListBackupsError, RuntimeContext>;
  /** Read one backup by id. */
  getBackup(
    request: GetBackupRequest,
  ): Effect.Effect<mongodb.GetBackupResponse, mongodb.GetBackupError, RuntimeContext>;
  /** List the instance's restore jobs and their status. */
  listRestoreJobs(
    request?: ListRestoreJobsRequest,
  ): Effect.Effect<mongodb.ListRestoreJobsResponse, mongodb.ListRestoreJobsError, RuntimeContext>;
  /** Read a metric of the instance's hosts as data points. */
  listMetrics(
    request: ListMetricsRequest,
  ): Effect.Effect<mongodb.ListMetricsResponse, mongodb.ListMetricsError, RuntimeContext>;
  /** List the slow queries the Performance Advisor detected. */
  listAdvisorSlowQueries(
    request?: ListAdvisorSlowQueriesRequest,
  ): Effect.Effect<
    mongodb.HandlersInstancesSlowQueriesResponse,
    mongodb.ListAdvisorSlowQueriesError,
    RuntimeContext
  >;
  /** List the indexes the Performance Advisor suggests. */
  listSuggestedIndexes(
    request?: ListSuggestedIndexesRequest,
  ): Effect.Effect<
    mongodb.HandlersInstancesSuggestedIndexesResponse,
    mongodb.ListSuggestedIndexesError,
    RuntimeContext
  >;
}

/**
 * Read an {@link Instance}, its users, backups, restore jobs, metrics and Performance
 * Advisor results from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the eight read permissions (`mongodb-flex.instance.get`,
 * `mongodb-flex.user.list`, `mongodb-flex.user.get`, `mongodb-flex.backup.list`,
 * `mongodb-flex.backup.get`, `mongodb-flex.backup.restore-list`, `mongodb-flex.metric.get`,
 * `mongodb-flex.advisor.list`), bound on the project holding the instance. STACKIT binds
 * roles on projects at the narrowest, so they reach every MongoDB Flex instance in that
 * project.
 *
 * ### Reading an Instance
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Db;
 *     const client = yield* Stackit.MongoDBFlex.ReadInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* client.listUsers();
 *         return yield* HttpServerResponse.json({ count: items?.length ?? 0 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface ReadInstance extends Binding.Service<
  ReadInstance,
  "Stackit.MongoDBFlex.ReadInstance",
  (instance: Instance) => Effect.Effect<ReadInstanceClient>
> {}

export const ReadInstance = Binding.Service<ReadInstance>("Stackit.MongoDBFlex.ReadInstance");
