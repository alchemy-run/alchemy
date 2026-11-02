import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeAutomationScopeHttpBinding } from "./BindingHttp.ts";
import { ListVolumeAutomations } from "./ListVolumeAutomations.ts";

/**
 * HTTP implementation of {@link ListVolumeAutomations}.
 *
 * @layer
 * @provides Stackit.Automation.ListVolumeAutomations
 */
export const ListVolumeAutomationsHttp = Layer.effect(
  ListVolumeAutomations,
  makeAutomationScopeHttpBinding({
    tag: "Stackit.Automation.ListVolumeAutomations",
    access: { permissions: ["automation-volumes.automation.list"] },
    operation: automation.listVolumeAutomations,
  }),
);
