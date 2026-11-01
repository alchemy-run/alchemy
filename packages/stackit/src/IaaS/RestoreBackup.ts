import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Backup } from "./Backup.ts";

/**
 * Runtime binding for IaaS `RestoreBackup`: overwrite the volume a backup was
 * taken from with the backup's contents. This is disruptive: the volume has to
 * be detached, and its current data is lost.
 *
 * Bind this operation to a {@link Backup} in a Function/Worker init phase and
 * provide {@link RestoreBackupHttp}. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.backup.restore` on the project
 * holding the backup, so it reaches every backup in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single backup.
 * The predefined IaaS roles grant far more than this one action. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *
 * ### Restoring a Backup
 * **Example:** Restore a volume from its backup
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Data = Stackit.IaaS.Volume("Data", { size: 10 }).pipe(
 *   Effect.flatMap((volume) =>
 *     Stackit.IaaS.Backup("DataBackup", {
 *       source: { type: "volume", id: volume.volumeId },
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const restore = yield* Stackit.IaaS.RestoreBackup(yield* Data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restore();
 *         return yield* HttpServerResponse.json({ restoring: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.RestoreBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Block Storage
 * @category IaaS
 */
export interface RestoreBackup extends Binding.Service<
  RestoreBackup,
  "Stackit.IaaS.RestoreBackup",
  (
    backup: Backup,
  ) => Effect.Effect<
    () => Effect.Effect<iaas.RestoreBackupResponse, iaas.RestoreBackupError, RuntimeContext>
  >
> {}

export const RestoreBackup = Binding.Service<RestoreBackup>("Stackit.IaaS.RestoreBackup");
