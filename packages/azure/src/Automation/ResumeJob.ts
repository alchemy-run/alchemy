import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AutomationAccount } from "./AutomationAccount.ts";

export interface ResumeJobRequest extends Omit<
  automation.ResumeJobRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName"
> {}

/**
 * Resume a suspended runbook job (`POST …/jobs/{jobName}/resume`) from any host.
 *
 * Binding assigns a custom role (`AzureAutomationResumeJobRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/jobs/resume/action`) on the Automation account only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ResumeJobHttp}.
 *
 * ### Calling ResumeJob
 * **Example:** ResumeJob from a Function
 * ```typescript
 * // init
 * const resumeJob = yield* Azure.Automation.ResumeJob(account);
 *
 * // runtime
 * yield* resumeJob({ jobName: "nightly-2026-10-25" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const resumeJob = yield* Azure.Automation.ResumeJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.ResumeJobHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface ResumeJob extends Binding.Service<
  ResumeJob,
  "Azure.Automation.ResumeJob",
  (
    account: AutomationAccount,
  ) => Effect.Effect<
    (
      request: ResumeJobRequest,
    ) => Effect.Effect<automation.ResumeJobResponse, automation.ResumeJobError, RuntimeContext>
  >
> {}

export const ResumeJob = Binding.Service<ResumeJob>("Azure.Automation.ResumeJob");
