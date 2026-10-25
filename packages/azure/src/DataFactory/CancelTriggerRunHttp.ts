import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { CancelTriggerRun } from "./CancelTriggerRun.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * Implementation of {@link CancelTriggerRun} over the distilled `datafactory` ARM
 * operation `CancelTriggerRun`. Assigns the custom `AzureDataFactoryCancelTriggerRunRole` on
 * the trigger.
 *
 * @layer
 * @provides Azure.DataFactory.CancelTriggerRun
 */
export const CancelTriggerRunHttp = Layer.effect(
  CancelTriggerRun,
  makeArmActionBinding({
    tag: "Azure.DataFactory.CancelTriggerRun",
    operation: datafactory.CancelTriggerRun,
    role: {
      role: "DataFactoryCancelTriggerRun",
      actions: ["Microsoft.DataFactory/factories/triggers/triggerruns/cancel/action"],
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
