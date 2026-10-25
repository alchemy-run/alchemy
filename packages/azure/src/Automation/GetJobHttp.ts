import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeAutomationAccountActionBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

/**
 * Implementation of {@link GetJob} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationGetJobRole` on the Automation account.
 *
 * @layer
 * @provides Azure.Automation.GetJob
 */
export const GetJobHttp = Layer.effect(
  GetJob,
  makeAutomationAccountActionBinding({
    tag: "Azure.Automation.GetJob",
    operation: automation.GetJob,
    role: AutomationRole.GetJob,
  }),
);
