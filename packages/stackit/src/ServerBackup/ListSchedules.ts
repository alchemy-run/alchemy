import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface ListSchedulesRequest extends Omit<
  serverBackup.ListBackupSchedulesRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `listBackupSchedules`: list a server's backup
 * schedules, including those not in this stack.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link ListSchedulesHttp}. The server's project, region and id are injected into
 * each request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup-schedule.list` on the
 * project holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Schedules
 * **Example:** List the server's schedules
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
 *     const listSchedules = yield* Stackit.ServerBackup.ListSchedules(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listSchedules();
 *         return yield* HttpServerResponse.json({ schedules: items?.map((schedule) => schedule.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.ListSchedulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface ListSchedules extends Binding.Service<
  ListSchedules,
  "Stackit.ServerBackup.ListSchedules",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: ListSchedulesRequest,
    ) => Effect.Effect<
      serverBackup.GetBackupSchedulesResponse,
      serverBackup.ListBackupSchedulesError,
      RuntimeContext
    >
  >
> {}

export const ListSchedules = Binding.Service<ListSchedules>("Stackit.ServerBackup.ListSchedules");
