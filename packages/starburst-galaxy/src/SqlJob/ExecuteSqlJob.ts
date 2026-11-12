import type * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlJob } from "./SqlJob.ts";

/**
 * Run the bound SQL job now, outside its schedule. Galaxy runs it
 * asynchronously (starting the cluster if it is suspended): poll
 * `GetSqlJobStatus`.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ExecuteSqlJob
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
 *     const executeSqlJob = yield* StarburstGalaxy.SqlJob.ExecuteSqlJob(Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* executeSqlJob();
 *         return yield* HttpServerResponse.json("started");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SqlJob.ExecuteSqlJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SqlJob
 */
export interface ExecuteSqlJob extends Binding.Service<
  ExecuteSqlJob,
  "StarburstGalaxy.SqlJob.ExecuteSqlJob",
  (
    job: SqlJob,
  ) => Effect.Effect<() => Effect.Effect<void, sqlJobs.ExecuteSqlJobError, RuntimeContext>>
> {}

export const ExecuteSqlJob = Binding.Service<ExecuteSqlJob>("StarburstGalaxy.SqlJob.ExecuteSqlJob");
