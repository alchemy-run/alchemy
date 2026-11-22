import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeAutomationAccountActionBinding } from "./BindingHttp.ts";
import { ResumeJob } from "./ResumeJob.ts";

/**
 * Implementation of {@link ResumeJob} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationResumeJobRole` on the Automation account.
 *
 * @layer
 * @provides Azure.Automation.ResumeJob
 */
export const ResumeJobHttp = Layer.effect(
  ResumeJob,
  makeAutomationAccountActionBinding({
    tag: "Azure.Automation.ResumeJob",
    operation: automation.ResumeJob,
    role: AutomationRole.ResumeJob,
  }),
);
