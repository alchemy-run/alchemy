import type * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlJob } from "./SqlJob.ts";

/**
 * Read the status of the bound SQL job's latest run: `Scheduled`,
 * `Queued`, `InProgress`, `Completed` or `Failed`, its progress and
 * error.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetSqlJobStatus
 * ```typescript
 * const reports = StarburstGalaxy.Cluster.Cluster.lookup({ name: "reports" });
 * const reporter = StarburstGalaxy.Role.Role.lookup({ name: "reporter" });
 * export const Nightly = StarburstGalaxy.SqlJob.SqlJob("Nightly", {
 *   role: reporter.roleId,
 *   cluster: reports.clusterId,
 *   schedule: "0 2 * * *",
 *   queries: ["INSERT INTO lake.reports.daily SELECT * FROM shop.sales.orders"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getSqlJobStatus = yield* StarburstGalaxy.SqlJob.GetSqlJobStatus(Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const status = yield* getSqlJobStatus();
 *         return yield* HttpServerResponse.json(status.status);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SqlJob.GetSqlJobStatusHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SqlJob
 */
export interface GetSqlJobStatus extends Binding.Service<
  GetSqlJobStatus,
  "StarburstGalaxy.SqlJob.GetSqlJobStatus",
  (
    job: SqlJob,
  ) => Effect.Effect<
    () => Effect.Effect<sqlJobs.SqlJobStatus, sqlJobs.GetSqlJobStatusError, RuntimeContext>
  >
> {}

export const GetSqlJobStatus = Binding.Service<GetSqlJobStatus>(
  "StarburstGalaxy.SqlJob.GetSqlJobStatus",
);
