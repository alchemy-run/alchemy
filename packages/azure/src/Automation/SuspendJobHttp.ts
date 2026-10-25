import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeAutomationAccountActionBinding } from "./BindingHttp.ts";
import { SuspendJob } from "./SuspendJob.ts";

/**
 * Implementation of {@link SuspendJob} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationSuspendJobRole` on the Automation account.
 *
 * @layer
 * @provides Azure.Automation.SuspendJob
 */
export const SuspendJobHttp = Layer.effect(
  SuspendJob,
  makeAutomationAccountActionBinding({
    tag: "Azure.Automation.SuspendJob",
    operation: automation.SuspendJob,
    role: AutomationRole.SuspendJob,
  }),
);
