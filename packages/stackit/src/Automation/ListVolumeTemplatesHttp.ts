import * as automation from "@distilled.cloud/stackit/automation";
import * as Layer from "effect/Layer";
import { makeAutomationScopeHttpBinding } from "./BindingHttp.ts";
import { ListVolumeTemplates } from "./ListVolumeTemplates.ts";

/**
 * HTTP implementation of {@link ListVolumeTemplates}.
 *
 * @layer
 * @provides Stackit.Automation.ListVolumeTemplates
 */
export const ListVolumeTemplatesHttp = Layer.effect(
  ListVolumeTemplates,
  makeAutomationScopeHttpBinding({
    tag: "Stackit.Automation.ListVolumeTemplates",
    access: { permissions: ["automation-volumes.automation.list"] },
    operation: automation.listVolumeTemplates,
  }),
);
