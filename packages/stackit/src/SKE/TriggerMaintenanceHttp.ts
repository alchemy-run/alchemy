import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { TriggerMaintenance } from "./TriggerMaintenance.ts";

/**
 * HTTP implementation of {@link TriggerMaintenance}.
 *
 * @layer
 * @provides Stackit.SKE.TriggerMaintenance
 */
export const TriggerMaintenanceHttp = Layer.effect(
  TriggerMaintenance,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.TriggerMaintenance",
    access: SKE_ACCESS.maintain,
    operation: ske.triggerMaintenance,
  }),
);
