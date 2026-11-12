import type * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlJob } from "./SqlJob.ts";

/**
 * List the bound SQL job's recent runs. Galaxy returns one page and
 * offers no way to ask for the next.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ListSqlJobHistory
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
 *     const listSqlJobHistory = yield* StarburstGalaxy.SqlJob.ListSqlJobHistory(Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const runs = yield* listSqlJobHistory();
 *         return yield* HttpServerResponse.json(runs.map((r) => r.status));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SqlJob.ListSqlJobHistoryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SqlJob
 */
export interface ListSqlJobHistory extends Binding.Service<
  ListSqlJobHistory,
  "StarburstGalaxy.SqlJob.ListSqlJobHistory",
  (
    job: SqlJob,
  ) => Effect.Effect<
    () => Effect.Effect<
      ReadonlyArray<sqlJobs.SqlJobHistory>,
      sqlJobs.ListSqlJobHistoryError,
      RuntimeContext
    >
  >
> {}

export const ListSqlJobHistory = Binding.Service<ListSqlJobHistory>(
  "StarburstGalaxy.SqlJob.ListSqlJobHistory",
);
