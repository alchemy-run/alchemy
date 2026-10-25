import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { StartTrigger } from "./StartTrigger.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * Implementation of {@link StartTrigger} over the distilled `datafactory` ARM
 * operation `StartTrigger`. Assigns the custom `AzureDataFactoryStartTriggerRole` on
 * the trigger.
 *
 * @layer
 * @provides Azure.DataFactory.StartTrigger
 */
export const StartTriggerHttp = Layer.effect(
  StartTrigger,
  makeArmActionBinding({
    tag: "Azure.DataFactory.StartTrigger",
    operation: datafactory.StartTrigger,
    role: {
      role: "DataFactoryStartTrigger",
      actions: ["Microsoft.DataFactory/factories/triggers/start/action"],
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
