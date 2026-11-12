import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/**
 * Restart a Postgres service, fail over to a standby (`switchover`), or
 * promote a read replica at runtime: runbooks and failover drills. A
 * replica promoted here is still declared as a replica by the stack;
 * remove its `replicaOf` too.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` and `control-plane:postgres-service:manage` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using UpdatePostgresServiceState
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
 *     const updateState = yield* ClickHouseCloud.Postgres.UpdatePostgresServiceState(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const svc = yield* updateState("switchover");
 *         return yield* HttpServerResponse.json({ state: svc.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.UpdatePostgresServiceStateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface UpdatePostgresServiceState extends Binding.Service<
  UpdatePostgresServiceState,
  "ClickHouseCloud.Postgres.UpdatePostgresServiceState",
  (
    target: Service,
  ) => Effect.Effect<
    (
      command: "restart" | "promote" | "switchover",
    ) => Effect.Effect<
      postgres.PostgresService,
      postgres.UpdatePostgresServiceStateError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const UpdatePostgresServiceState = Binding.Service<UpdatePostgresServiceState>(
  "ClickHouseCloud.Postgres.UpdatePostgresServiceState",
);
