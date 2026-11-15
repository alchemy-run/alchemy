import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "./Service.ts";

/**
 * Read a Postgres service at runtime: its state, size, high availability
 * and host name. Use it for health checks.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using GetPostgresService
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
 *     const getPostgresService = yield* ClickHouseCloud.Postgres.GetPostgresService(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const svc = yield* getPostgresService();
 *         return yield* HttpServerResponse.json({ state: svc.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.GetPostgresServiceHttp)),
 * ) {}
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `getPostgresService`.
 *
 * @binding
 * @product Postgres
 */
export interface GetPostgresService extends Binding.Service<
  GetPostgresService,
  "ClickHouseCloud.Postgres.GetPostgresService",
  (
    target: Service,
  ) => Effect.Effect<
    () => Effect.Effect<postgres.PostgresService, postgres.GetPostgresServiceError, RuntimeContext>
  >
> {}

export const GetPostgresService = Binding.Service<GetPostgresService>(
  "ClickHouseCloud.Postgres.GetPostgresService",
);
