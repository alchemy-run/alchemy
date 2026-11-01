import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeVolumeAutomationHttpBinding } from "./BindingHttp.ts";
import { GetVolumeExecution } from "./GetVolumeExecution.ts";

/**
 * HTTP implementation of {@link GetVolumeExecution}.
 *
 * @layer
 * @provides Stackit.Automation.GetVolumeExecution
 */
export const GetVolumeExecutionHttp = Layer.effect(
  GetVolumeExecution,
  makeVolumeAutomationHttpBinding({
    tag: "Stackit.Automation.GetVolumeExecution",
    access: { permissions: ["automation-volumes.execution.get"] },
    operation: automation.getVolumeExecution,
  }),
);
