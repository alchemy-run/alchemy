import type * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "../Service/Service.ts";

/**
 * List every snapshot of a ClickHouse Cloud service at runtime, newest
 * first, all pages. Pick the latest `done` snapshot as a recovery point.
 * The endpoint is in beta and early access.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:view-snapshots`
 * on the bound service. ClickHouse Cloud federates no workload identity, so
 * a key is the only way in.
 *
 * ### Listing Snapshots
 * **Example:** The latest finished snapshot
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
 *     const listSnapshots = yield* ClickHouseCloud.Snapshot.ListSnapshots(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const snapshots = yield* listSnapshots();
 *         const latest = snapshots.find((s) => s.status === "done");
 *         return yield* HttpServerResponse.json({ latest: latest?.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Snapshot.ListSnapshotsHttp)),
 * ) {}
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `listSnapshots`.
 *
 * @binding
 * @product Snapshot
 */
export interface ListSnapshots extends Binding.Service<
  ListSnapshots,
  "ClickHouseCloud.Snapshot.ListSnapshots",
  (
    target: Service,
  ) => Effect.Effect<
    () => Effect.Effect<snapshot.Snapshot[], snapshot.ListSnapshotsError, RuntimeContext>
  >
> {}

export const ListSnapshots = Binding.Service<ListSnapshots>(
  "ClickHouseCloud.Snapshot.ListSnapshots",
);
