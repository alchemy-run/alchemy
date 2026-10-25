import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { RerunTriggerRun } from "./RerunTriggerRun.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * Implementation of {@link RerunTriggerRun} over the distilled `datafactory` ARM
 * operation `TriggerRunsRerun`. Assigns the custom `AzureDataFactoryRerunTriggerRunRole` on
 * the trigger.
 *
 * @layer
 * @provides Azure.DataFactory.RerunTriggerRun
 */
export const RerunTriggerRunHttp = Layer.effect(
  RerunTriggerRun,
  makeArmActionBinding({
    tag: "Azure.DataFactory.RerunTriggerRun",
    operation: datafactory.TriggerRunsRerun,
    role: {
      role: "DataFactoryRerunTriggerRun",
      actions: ["Microsoft.DataFactory/factories/triggers/triggerruns/rerun/action"],
    },
    resourceId: (trigger: Trigger) => trigger.triggerId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
      triggerName: id.name("triggers"),
    }),
  }),
);
