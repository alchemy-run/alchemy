import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestore } from "./TriggerRestore.ts";

/**
 * HTTP implementation of {@link TriggerRestore}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.TriggerRestore
 */
export const TriggerRestoreHttp = Layer.effect(
  TriggerRestore,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.TriggerRestore",
    access: { permissions: ["sqlserver-flex.restore.trigger"] },
    operation: sqlserver.triggerRestore,
  }),
);
