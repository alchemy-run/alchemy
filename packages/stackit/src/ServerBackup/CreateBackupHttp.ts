import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.CreateBackup",
    access: { permissions: ["server-backup.backup.create"] },
    operation: serverBackup.createBackup,
  }),
);
