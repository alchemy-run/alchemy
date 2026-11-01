import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface GetBackupRequest extends Omit<
  serverBackup.GetBackupRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `getBackup`: read a backup of a server, by id,
 * such as to poll its `status`.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link GetBackupHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.get` on the project holding
 * the server, so it reaches every server in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Backup
 * **Example:** Report a backup's status
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
 *     const getBackup = yield* Stackit.ServerBackup.GetBackup(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* getBackup({ backupId: "<backup id>" });
 *         return yield* HttpServerResponse.json({ status: backup.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.GetBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface GetBackup extends Binding.Service<
  GetBackup,
  "Stackit.ServerBackup.GetBackup",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: GetBackupRequest,
    ) => Effect.Effect<serverBackup.Backup, serverBackup.GetBackupError, RuntimeContext>
  >
> {}

export const GetBackup = Binding.Service<GetBackup>("Stackit.ServerBackup.GetBackup");
