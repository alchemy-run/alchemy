import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeBackupHttpBinding } from "./BindingHttp.ts";
import { RestoreBackup } from "./RestoreBackup.ts";

/**
 * HTTP implementation of {@link RestoreBackup}.
 *
 * @layer
 * @provides Stackit.IaaS.RestoreBackup
 */
export const RestoreBackupHttp = Layer.effect(
  RestoreBackup,
  makeBackupHttpBinding({
    tag: "Stackit.IaaS.RestoreBackup",
    access: { permissions: ["iaas.backup.restore"] },
    operation: iaas.restoreBackup,
  }),
);
