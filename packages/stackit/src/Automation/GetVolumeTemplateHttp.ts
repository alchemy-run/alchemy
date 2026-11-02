import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeAutomationScopeHttpBinding } from "./BindingHttp.ts";
import { GetVolumeTemplate } from "./GetVolumeTemplate.ts";

/**
 * HTTP implementation of {@link GetVolumeTemplate}.
 *
 * @layer
 * @provides Stackit.Automation.GetVolumeTemplate
 */
export const GetVolumeTemplateHttp = Layer.effect(
  GetVolumeTemplate,
  makeAutomationScopeHttpBinding({
    tag: "Stackit.Automation.GetVolumeTemplate",
    access: { permissions: ["automation-volumes.automation.get"] },
    operation: automation.getVolumeTemplate,
  }),
);
