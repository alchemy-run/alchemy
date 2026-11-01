import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { RestoreVolumeBackup } from "./RestoreVolumeBackup.ts";

/**
 * HTTP implementation of {@link RestoreVolumeBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.RestoreVolumeBackup
 */
export const RestoreVolumeBackupHttp = Layer.effect(
  RestoreVolumeBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.RestoreVolumeBackup",
    access: { permissions: ["server-backup.backup.volume-backup.restore"] },
    operation: serverBackup.restoreVolumeBackup,
  }),
);
