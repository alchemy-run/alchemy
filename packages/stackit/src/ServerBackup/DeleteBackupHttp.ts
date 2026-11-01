import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { DeleteBackup } from "./DeleteBackup.ts";

/**
 * HTTP implementation of {@link DeleteBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.DeleteBackup
 */
export const DeleteBackupHttp = Layer.effect(
  DeleteBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.DeleteBackup",
    access: { permissions: ["server-backup.backup.delete"] },
    operation: serverBackup.deleteBackup,
  }),
);
