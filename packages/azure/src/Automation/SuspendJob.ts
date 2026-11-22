import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AutomationAccount } from "./AutomationAccount.ts";

export interface SuspendJobRequest extends Omit<
  automation.SuspendJobRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName"
> {}

/**
 * Suspend a running job of a PowerShell Workflow or graphical runbook (`POST …/jobs/{jobName}/suspend`) from any host.
 *
 * Binding assigns a custom role (`AzureAutomationSuspendJobRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/jobs/suspend/action`) on the Automation account only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SuspendJobHttp}.
 *
 * ### Calling SuspendJob
 * **Example:** SuspendJob from a Function
 * ```typescript
 * // init
 * const suspendJob = yield* Azure.Automation.SuspendJob(account);
 *
 * // runtime
 * yield* suspendJob({ jobName: "nightly-2026-10-25" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const suspendJob = yield* Azure.Automation.SuspendJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.SuspendJobHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface SuspendJob extends Binding.Service<
  SuspendJob,
  "Azure.Automation.SuspendJob",
  (
    account: AutomationAccount,
  ) => Effect.Effect<
    (
      request: SuspendJobRequest,
    ) => Effect.Effect<automation.SuspendJobResponse, automation.SuspendJobError, RuntimeContext>
  >
> {}

export const SuspendJob = Binding.Service<SuspendJob>("Azure.Automation.SuspendJob");
