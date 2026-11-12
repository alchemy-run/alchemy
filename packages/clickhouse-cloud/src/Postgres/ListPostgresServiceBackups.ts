import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "./Service.ts";

/**
 * List every completed base backup of a Postgres service at runtime, all
 * pages. Restores pick a point in time, not a backup: use the service's
 * `earliestRestoreTime`.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using ListPostgresServiceBackups
 * **Example:** From a Worker
 * ```typescript
 * export const AppDb = ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.medium",
 * });
 *
 * export default class Ops extends Cloudflare.Worker<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listBackups = yield* ClickHouseCloud.Postgres.ListPostgresServiceBackups(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const backups = yield* listBackups();
 *         return yield* HttpServerResponse.json(backups.map((b) => b.lastModified));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.ListPostgresServiceBackupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface ListPostgresServiceBackups extends Binding.Service<
  ListPostgresServiceBackups,
  "ClickHouseCloud.Postgres.ListPostgresServiceBackups",
  (
    target: Service,
  ) => Effect.Effect<
    () => Effect.Effect<
      postgres.PostgresBackup[],
      postgres.ListPostgresServiceBackupsError,
      RuntimeContext
    >
  >
> {}

export const ListPostgresServiceBackups = Binding.Service<ListPostgresServiceBackups>(
  "ClickHouseCloud.Postgres.ListPostgresServiceBackups",
);
