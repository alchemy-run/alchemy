import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface RestoreBackupRequest extends Omit<
  serverBackup.RestoreBackupRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `restoreBackup`: restore a server from one of its
 * backups, by id. This is disruptive: what's on the restored volumes now is replaced.
 * Pass `volumeIds` to restore only some volumes. It only starts the restore, and fails
 * with `Conflict` while one is running.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link RestoreBackupHttp}. The server's project, region and id are injected into
 * each request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.restore` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Restoring a Backup
 * **Example:** Restore a server and start it again
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
 *     const restoreBackup = yield* Stackit.ServerBackup.RestoreBackup(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restoreBackup({ backupId: "<backup id>", startServerAfterRestore: true });
 *         return HttpServerResponse.text("restoring");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.RestoreBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface RestoreBackup extends Binding.Service<
  RestoreBackup,
  "Stackit.ServerBackup.RestoreBackup",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: RestoreBackupRequest,
    ) => Effect.Effect<
      serverBackup.RestoreBackupResponse,
      serverBackup.RestoreBackupError,
      RuntimeContext
    >
  >
> {}

export const RestoreBackup = Binding.Service<RestoreBackup>("Stackit.ServerBackup.RestoreBackup");
