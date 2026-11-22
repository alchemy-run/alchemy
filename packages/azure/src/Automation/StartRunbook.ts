import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Runbook } from "./Runbook.ts";

export interface StartRunbookRequest {
  /** Name of the new job (`PUT …/jobs/{jobName}`), usually a GUID. */
  jobName: string;
  /** Runbook parameters by name. */
  parameters?: Record<string, string>;
  /**
   * Hybrid worker group to run on.
   * @default Azure's cloud sandbox
   */
  runOn?: string;
}

/**
 * Start a job of the bound runbook (`PUT …/automationAccounts/{account}/jobs/{jobName}`
 * naming the runbook) from any host. Poll it with {@link GetJob}; stop,
 * suspend or resume it with {@link StopJob}, {@link SuspendJob},
 * {@link ResumeJob}.
 *
 * Binding assigns a custom role (`AzureAutomationStartRunbookRole`, one per
 * stack, with exactly the action
 * `Microsoft.Automation/automationAccounts/jobs/write`) on the runbook's
 * Automation account: jobs are children of the account, so Azure checks
 * the grant there, and a host holding it can start any runbook in that
 * account.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartRunbookHttp}.
 *
 * ### Calling StartRunbook
 * **Example:** Start a runbook job from a Function
 * ```typescript
 * // init
 * const startRunbook = yield* Azure.Automation.StartRunbook(runbook);
 *
 * // runtime
 * yield* startRunbook({ jobName: crypto.randomUUID(), parameters: { Target: "prod" } });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startRunbook = yield* Azure.Automation.StartRunbook(runbook);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.StartRunbookHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface StartRunbook extends Binding.Service<
  StartRunbook,
  "Azure.Automation.StartRunbook",
  (
    runbook: Runbook,
  ) => Effect.Effect<
    (
      request: StartRunbookRequest,
    ) => Effect.Effect<automation.CreateJobResponse, automation.CreateJobError, RuntimeContext>
  >
> {}

export const StartRunbook = Binding.Service<StartRunbook>("Azure.Automation.StartRunbook");
