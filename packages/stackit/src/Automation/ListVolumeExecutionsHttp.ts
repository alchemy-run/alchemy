import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeVolumeAutomationHttpBinding } from "./BindingHttp.ts";
import { ListVolumeExecutions } from "./ListVolumeExecutions.ts";

/**
 * HTTP implementation of {@link ListVolumeExecutions}.
 *
 * @layer
 * @provides Stackit.Automation.ListVolumeExecutions
 */
export const ListVolumeExecutionsHttp = Layer.effect(
  ListVolumeExecutions,
  makeVolumeAutomationHttpBinding({
    tag: "Stackit.Automation.ListVolumeExecutions",
    access: { permissions: ["automation-volumes.execution.list"] },
    operation: automation.listVolumeExecutions,
  }),
);
