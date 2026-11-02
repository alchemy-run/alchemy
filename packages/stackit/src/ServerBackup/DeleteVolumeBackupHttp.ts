import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { DeleteVolumeBackup } from "./DeleteVolumeBackup.ts";

/**
 * HTTP implementation of {@link DeleteVolumeBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.DeleteVolumeBackup
 */
export const DeleteVolumeBackupHttp = Layer.effect(
  DeleteVolumeBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.DeleteVolumeBackup",
    access: { permissions: ["server-backup.backup.volume-backup.delete"] },
    operation: serverBackup.deleteVolumeBackup,
  }),
);
