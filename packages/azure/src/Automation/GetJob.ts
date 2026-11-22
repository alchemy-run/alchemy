import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AutomationAccount } from "./AutomationAccount.ts";

export interface GetJobRequest extends Omit<
  automation.GetJobRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName"
> {}

/**
 * Read a runbook job's status, timing and exception (`GET …/jobs/{jobName}`) from any host.
 *
 * Binding assigns a custom role (`AzureAutomationGetJobRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/jobs/read`) on the Automation account only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetJobHttp}.
 *
 * ### Calling GetJob
 * **Example:** GetJob from a Function
 * ```typescript
 * // init
 * const getJob = yield* Azure.Automation.GetJob(account);
 *
 * // runtime
 * yield* getJob({ jobName: "nightly-2026-10-25" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getJob = yield* Azure.Automation.GetJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.GetJobHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "Azure.Automation.GetJob",
  (
    account: AutomationAccount,
  ) => Effect.Effect<
    (
      request: GetJobRequest,
    ) => Effect.Effect<automation.GetJobResponse, automation.GetJobError, RuntimeContext>
  >
> {}

export const GetJob = Binding.Service<GetJob>("Azure.Automation.GetJob");
