import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Backup } from "./Backup.ts";
import { makeAlloyDbBackupHttpBinding } from "./BindingHttp.ts";

export interface GetBackupRequest extends Omit<
  alloydb.GetProjectsLocationsBackupsRequest,
  "name"
> {}

/**
 * Runtime binding for AlloyDB `backups.get`.
 *
 * Bind this operation to a {@link Backup} in a Function/Action init
 * phase. Provide {@link GetBackupHttp}.
 *
 * ### Observing Backups
 * **Example:** Read the bound backup
 * ```typescript
 * const getBackup = yield* GCP.AlloyDB.GetBackup(backup);
 * const live = yield* getBackup();
 * ```
 *
 * @binding
 * @category AlloyDB
 */
export interface GetBackup extends Binding.Service<
  GetBackup,
  "GCP.AlloyDB.GetBackup",
  (
    backup: Backup,
  ) => Effect.Effect<
    (
      request?: GetBackupRequest,
    ) => Effect.Effect<alloydb.Backup, alloydb.GetProjectsLocationsBackupsError, RuntimeContext>
  >
> {}

export const GetBackup = Binding.Service<GetBackup>("GCP.AlloyDB.GetBackup");

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeAlloyDbBackupHttpBinding({
    tag: "GCP.AlloyDB.GetBackup",
    iam: { role: "roles/alloydb.viewer" },
    operation: alloydb.getProjectsLocationsBackups,
  }),
);
