import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { StopTrigger } from "./StopTrigger.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * Implementation of {@link StopTrigger} over the distilled `datafactory` ARM
 * operation `StopTrigger`. Assigns the custom `AzureDataFactoryStopTriggerRole` on
 * the trigger.
 *
 * @layer
 * @provides Azure.DataFactory.StopTrigger
 */
export const StopTriggerHttp = Layer.effect(
  StopTrigger,
  makeArmActionBinding({
    tag: "Azure.DataFactory.StopTrigger",
    operation: datafactory.StopTrigger,
    role: {
      role: "DataFactoryStopTrigger",
      actions: ["Microsoft.DataFactory/factories/triggers/stop/action"],
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
