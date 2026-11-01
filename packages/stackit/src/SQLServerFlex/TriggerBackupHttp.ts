import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerBackup } from "./TriggerBackup.ts";

/**
 * HTTP implementation of {@link TriggerBackup}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.TriggerBackup
 */
export const TriggerBackupHttp = Layer.effect(
  TriggerBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.TriggerBackup",
    access: { permissions: ["sqlserver-flex.backup.trigger"] },
    operation: sqlserver.triggerBackup,
  }),
);
