import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface DeleteVolumeBackupRequest extends Omit<
  serverBackup.DeleteVolumeBackupRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `deleteVolumeBackup`: delete one volume's part of
 * a server's backup, keeping the rest. That volume's data in the backup is gone. Pass
 * `force` to send the API's force flag.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link DeleteVolumeBackupHttp}. The server's project, region and id are injected
 * into each request. It works on any host. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.volume-backup.delete` on
 * the project holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Deleting One Volume
 * **Example:** Delete a volume backup by id
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
 *     const deleteVolumeBackup = yield* Stackit.ServerBackup.DeleteVolumeBackup(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteVolumeBackup({ backupId: "<backup id>", volumeBackupId: "<volume backup id>" });
 *         return HttpServerResponse.text("deleting");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.DeleteVolumeBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface DeleteVolumeBackup extends Binding.Service<
  DeleteVolumeBackup,
  "Stackit.ServerBackup.DeleteVolumeBackup",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: DeleteVolumeBackupRequest,
    ) => Effect.Effect<
      serverBackup.DeleteVolumeBackupResponse,
      serverBackup.DeleteVolumeBackupError,
      RuntimeContext
    >
  >
> {}

export const DeleteVolumeBackup = Binding.Service<DeleteVolumeBackup>(
  "Stackit.ServerBackup.DeleteVolumeBackup",
);
