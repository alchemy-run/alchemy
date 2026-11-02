import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { RestoreDatabaseFromBackup } from "./RestoreDatabaseFromBackup.ts";

/**
 * HTTP implementation of {@link RestoreDatabaseFromBackup}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.RestoreDatabaseFromBackup
 */
export const RestoreDatabaseFromBackupHttp = Layer.effect(
  RestoreDatabaseFromBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.RestoreDatabaseFromBackup",
    access: { permissions: ["sqlserver-flex.restore.trigger"] },
    operation: sqlserver.restoreDatabaseFromBackup,
  }),
);
