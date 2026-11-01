import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.GetBackup",
    access: { permissions: ["sqlserver-flex.backup.get"] },
    operation: sqlserver.getBackup,
  }),
);
