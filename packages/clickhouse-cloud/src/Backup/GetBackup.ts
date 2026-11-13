import type * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "../Service/Service.ts";

/**
 * Read one backup of a ClickHouse Cloud service at runtime: its status
 * (`done`, `error`, `in_progress`), size, duration and bucket.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:view-backups` on
 * the bound service. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Reading a Backup
 * **Example:** Check whether a backup finished
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
 *     const getBackup = yield* ClickHouseCloud.Backup.GetBackup(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const id = new URL(request.url, "http://worker").searchParams.get("id")!;
 *         // runtime
 *         const found = yield* getBackup(id);
 *         return yield* HttpServerResponse.json({ status: found.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Backup.GetBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Backup
 */
export interface GetBackup extends Binding.Service<
  GetBackup,
  "ClickHouseCloud.Backup.GetBackup",
  (
    target: Service,
  ) => Effect.Effect<
    (backupId: string) => Effect.Effect<backup.Backup, backup.GetBackupError, RuntimeContext>
  >
> {}

export const GetBackup = Binding.Service<GetBackup>("ClickHouseCloud.Backup.GetBackup");
