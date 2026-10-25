import * as logic from "@distilled.cloud/azure/logic";
import * as Layer from "effect/Layer";
import { LogicRole, makeWorkflowActionBinding } from "./BindingHttp.ts";
import { ResetWorkflowTrigger } from "./ResetWorkflowTrigger.ts";

/**
 * Implementation of {@link ResetWorkflowTrigger} over the distilled `logic` ARM
 * API. Assigns the custom `AzureLogicResetWorkflowTriggerRole` on the workflow.
 *
 * @layer
 * @provides Azure.Logic.ResetWorkflowTrigger
 */
export const ResetWorkflowTriggerHttp = Layer.effect(
  ResetWorkflowTrigger,
  makeWorkflowActionBinding({
    tag: "Azure.Logic.ResetWorkflowTrigger",
    operation: logic.ResetWorkflowTrigger,
    role: LogicRole.ResetWorkflowTrigger,
  }),
);
