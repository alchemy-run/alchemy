import type * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "../Service/Service.ts";

/**
 * List the backups of a ClickHouse Cloud service at runtime, newest first.
 * Pick the latest `done` backup to restore it into a new service
 * (`ClickHouseCloud.Service.Service` with `backupId`).
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:view-backups` on
 * the bound service. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Listing Backups
 * **Example:** The latest finished backup
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 *
 * export default class Backups extends Cloudflare.Worker<Backups>()(
 *   "Backups",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:service:view and :view-backups on the service
 *     const listBackups = yield* ClickHouseCloud.Backup.ListBackups(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const backups = yield* listBackups();
 *         const latest = backups.find((b) => b.status === "done");
 *         return yield* HttpServerResponse.json({ latest: latest?.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Backup.ListBackupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Backup
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "ClickHouseCloud.Backup.ListBackups",
  (
    target: Service,
  ) => Effect.Effect<() => Effect.Effect<backup.Backup[], backup.ListBackupsError, RuntimeContext>>
> {}

export const ListBackups = Binding.Service<ListBackups>("ClickHouseCloud.Backup.ListBackups");
