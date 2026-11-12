import type * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "../Service/Service.ts";

/**
 * Read one snapshot of a ClickHouse Cloud service at runtime: its status
 * (`done`, `error`, `in_progress`, `throttled`), size, duration and bucket.
 * The endpoint is in beta and early access.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:view-snapshots`
 * on the bound service. ClickHouse Cloud federates no workload identity, so
 * a key is the only way in.
 *
 * ### Reading a Snapshot
 * **Example:** Whether a snapshot finished
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 *
 * export default class Snapshots extends Cloudflare.Worker<Snapshots>()(
 *   "Snapshots",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getSnapshot = yield* ClickHouseCloud.Snapshot.GetSnapshot(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const id = new URL(request.url, "http://worker").searchParams.get("id")!;
 *         // runtime
 *         const found = yield* getSnapshot(id);
 *         return yield* HttpServerResponse.json({ status: found.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Snapshot.GetSnapshotHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Snapshot
 */
export interface GetSnapshot extends Binding.Service<
  GetSnapshot,
  "ClickHouseCloud.Snapshot.GetSnapshot",
  (
    target: Service,
  ) => Effect.Effect<
    (
      snapshotId: string,
    ) => Effect.Effect<snapshot.Snapshot, snapshot.GetSnapshotError | ResultMissing, RuntimeContext>
  >
> {}

export const GetSnapshot = Binding.Service<GetSnapshot>("ClickHouseCloud.Snapshot.GetSnapshot");
