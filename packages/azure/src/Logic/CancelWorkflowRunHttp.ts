import * as logic from "@distilled.cloud/azure/logic";
import * as Layer from "effect/Layer";
import { LogicRole, makeWorkflowActionBinding } from "./BindingHttp.ts";
import { CancelWorkflowRun } from "./CancelWorkflowRun.ts";

/**
 * Implementation of {@link CancelWorkflowRun} over the distilled `logic` ARM
 * API. Assigns the custom `AzureLogicCancelWorkflowRunRole` on the workflow.
 *
 * @layer
 * @provides Azure.Logic.CancelWorkflowRun
 */
export const CancelWorkflowRunHttp = Layer.effect(
  CancelWorkflowRun,
  makeWorkflowActionBinding({
    tag: "Azure.Logic.CancelWorkflowRun",
    operation: logic.CancelWorkflowRun,
    role: LogicRole.CancelWorkflowRun,
  }),
);
