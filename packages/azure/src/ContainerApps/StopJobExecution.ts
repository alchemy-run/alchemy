import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";

/** `StopJobExecution` request without the job's identifiers, which the bound job supplies. */
export interface StopJobExecutionRequest extends Omit<
  app.StopJobExecutionRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Stop one running execution of a Container Apps job.
 *
 * Binding assigns a custom role (`AzureContainerAppsJobExecutionStopRole`, one per stack) with exactly
 * the action `Microsoft.App/jobs/stop/execution/action`, on the job only. The
 * smallest built-in role, **Container Apps Jobs Operator**, also reads the job and starts and stops its executions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopJobExecutionHttp}.
 *
 * ### Calling StopJobExecution
 * **Example:** StopJobExecution from a Function
 * ```typescript
 * const Nightly = Azure.ContainerApps.Job("Nightly", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const nightly = yield* Nightly;
 *     const stopExecution = yield* Azure.ContainerApps.StopJobExecution(nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* stopExecution({ jobExecutionName: "nightly-x7k2p" });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.StopJobExecutionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface StopJobExecution extends Binding.Service<
  StopJobExecution,
  "Azure.ContainerApps.StopJobExecution",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request: StopJobExecutionRequest,
    ) => Effect.Effect<app.StopJobExecutionResponse, app.StopJobExecutionError, RuntimeContext>
  >
> {}

export const StopJobExecution = Binding.Service<StopJobExecution>(
  "Azure.ContainerApps.StopJobExecution",
);
