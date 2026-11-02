import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeVolumeAutomationHttpBinding } from "./BindingHttp.ts";
import { GetVolumeAutomation } from "./GetVolumeAutomation.ts";

/**
 * HTTP implementation of {@link GetVolumeAutomation}.
 *
 * @layer
 * @provides Stackit.Automation.GetVolumeAutomation
 */
export const GetVolumeAutomationHttp = Layer.effect(
  GetVolumeAutomation,
  makeVolumeAutomationHttpBinding({
    tag: "Stackit.Automation.GetVolumeAutomation",
    access: { permissions: ["automation-volumes.automation.get"] },
    operation: automation.getVolumeAutomation,
  }),
);
