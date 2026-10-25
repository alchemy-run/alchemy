import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AutomationAccount } from "./AutomationAccount.ts";

export interface StopJobRequest extends Omit<
  automation.StopJobRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName"
> {}

/**
 * Stop a runbook job (`POST …/jobs/{jobName}/stop`) from any host.
 *
 * Binding assigns a custom role (`AzureAutomationStopJobRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/jobs/stop/action`) on the Automation account only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopJobHttp}.
 *
 * ### Calling StopJob
 * **Example:** StopJob from a Function
 * ```typescript
 * // init
 * const stopJob = yield* Azure.Automation.StopJob(account);
 *
 * // runtime
 * yield* stopJob({ jobName: "nightly-2026-10-25" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopJob = yield* Azure.Automation.StopJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.StopJobHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface StopJob extends Binding.Service<
  StopJob,
  "Azure.Automation.StopJob",
  (
    account: AutomationAccount,
  ) => Effect.Effect<
    (
      request: StopJobRequest,
    ) => Effect.Effect<automation.StopJobResponse, automation.StopJobError, RuntimeContext>
  >
> {}

export const StopJob = Binding.Service<StopJob>("Azure.Automation.StopJob");
