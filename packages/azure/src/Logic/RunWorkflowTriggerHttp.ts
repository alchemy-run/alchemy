import * as logic from "@distilled.cloud/azure/logic";
import * as Layer from "effect/Layer";
import { LogicRole, makeWorkflowActionBinding } from "./BindingHttp.ts";
import { RunWorkflowTrigger } from "./RunWorkflowTrigger.ts";

/**
 * Implementation of {@link RunWorkflowTrigger} over the distilled `logic` ARM
 * API. Assigns the custom `AzureLogicRunWorkflowTriggerRole` on the workflow.
 *
 * @layer
 * @provides Azure.Logic.RunWorkflowTrigger
 */
export const RunWorkflowTriggerHttp = Layer.effect(
  RunWorkflowTrigger,
  makeWorkflowActionBinding({
    tag: "Azure.Logic.RunWorkflowTrigger",
    operation: logic.TriggerRunWorkflow,
    role: LogicRole.RunWorkflowTrigger,
  }),
);
