import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface RestoreVolumeBackupRequest extends Omit<
  serverBackup.RestoreVolumeBackupRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `restoreVolumeBackup`: restore one volume backup
 * of a server's backup onto a volume. This is disruptive: what's on `restoreVolumeId`
 * now is replaced. It only starts the restore.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link RestoreVolumeBackupHttp}. The server's project, region and id are injected
 * into each request. It works on any host. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.volume-backup.restore` on
 * the project holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Restoring One Volume
 * **Example:** Restore a volume backup onto a volume
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   imageId: "00000000-0000-0000-0000-000000000000",
 *   networking: { networkId: "11111111-1111-1111-1111-111111111111" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const restoreVolumeBackup = yield* Stackit.ServerBackup.RestoreVolumeBackup(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restoreVolumeBackup({
 *           backupId: "<backup id>",
 *           volumeBackupId: "<volume backup id>",
 *           restoreVolumeId: "<volume id>",
 *         });
 *         return HttpServerResponse.text("restoring");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.RestoreVolumeBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface RestoreVolumeBackup extends Binding.Service<
  RestoreVolumeBackup,
  "Stackit.ServerBackup.RestoreVolumeBackup",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: RestoreVolumeBackupRequest,
    ) => Effect.Effect<
      serverBackup.RestoreVolumeBackupResponse,
      serverBackup.RestoreVolumeBackupError,
      RuntimeContext
    >
  >
> {}

export const RestoreVolumeBackup = Binding.Service<RestoreVolumeBackup>(
  "Stackit.ServerBackup.RestoreVolumeBackup",
);
