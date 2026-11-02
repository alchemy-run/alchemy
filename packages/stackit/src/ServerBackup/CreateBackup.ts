import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface CreateBackupRequest extends Omit<
  serverBackup.CreateBackupRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Backup `createBackup`: take a backup of a server now,
 * such as before a risky job. The server needs a `Stackit.ServerBackup.Enablement`.
 * The call fails with `Conflict` while a backup of the server is running. It only
 * starts the backup: poll `Stackit.ServerBackup.GetBackup` with the returned id until
 * it's `available`.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link CreateBackupHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup.create` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Taking a Backup
 * **Example:** Back up before a risky job
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
 *     const createBackup = yield* Stackit.ServerBackup.CreateBackup(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* createBackup({ name: "before-migration", retentionPeriod: 7 });
 *         return yield* HttpServerResponse.json({ backupId: job.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.CreateBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "Stackit.ServerBackup.CreateBackup",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: CreateBackupRequest,
    ) => Effect.Effect<serverBackup.BackupJob, serverBackup.CreateBackupError, RuntimeContext>
  >
> {}

export const CreateBackup = Binding.Service<CreateBackup>("Stackit.ServerBackup.CreateBackup");
