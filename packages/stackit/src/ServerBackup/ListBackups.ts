import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface ListBackupsRequest extends Omit<
  serverBackup.ListBackupsRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `listBackups`: list a server's backups, including
 * those schedules took and those not in this stack.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link ListBackupsHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.list` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Listing Backups
 * **Example:** List the server's backups
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
 *     const listBackups = yield* Stackit.ServerBackup.ListBackups(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listBackups();
 *         return yield* HttpServerResponse.json({ backups: items?.map((backup) => backup.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.ListBackupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "Stackit.ServerBackup.ListBackups",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: ListBackupsRequest,
    ) => Effect.Effect<
      serverBackup.GetBackupsListResponse,
      serverBackup.ListBackupsError,
      RuntimeContext
    >
  >
> {}

export const ListBackups = Binding.Service<ListBackups>("Stackit.ServerBackup.ListBackups");
