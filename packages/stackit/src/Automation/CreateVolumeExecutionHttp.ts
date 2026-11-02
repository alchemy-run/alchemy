import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeVolumeAutomationHttpBinding } from "./BindingHttp.ts";
import { CreateVolumeExecution } from "./CreateVolumeExecution.ts";

/**
 * HTTP implementation of {@link CreateVolumeExecution}.
 *
 * @layer
 * @provides Stackit.Automation.CreateVolumeExecution
 */
export const CreateVolumeExecutionHttp = Layer.effect(
  CreateVolumeExecution,
  makeVolumeAutomationHttpBinding({
    tag: "Stackit.Automation.CreateVolumeExecution",
    access: { permissions: ["automation-volumes.execution.create"] },
    operation: automation.createVolumeExecution,
  }),
);
