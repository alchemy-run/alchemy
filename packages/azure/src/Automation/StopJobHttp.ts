import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeAutomationAccountActionBinding } from "./BindingHttp.ts";
import { StopJob } from "./StopJob.ts";

/**
 * Implementation of {@link StopJob} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationStopJobRole` on the Automation account.
 *
 * @layer
 * @provides Azure.Automation.StopJob
 */
export const StopJobHttp = Layer.effect(
  StopJob,
  makeAutomationAccountActionBinding({
    tag: "Azure.Automation.StopJob",
    operation: automation.StopJob,
    role: AutomationRole.StopJob,
  }),
);
