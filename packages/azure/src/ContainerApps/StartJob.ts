import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";

/** `StartJob` request without the job's identifiers, which the bound job supplies. */
export interface StartJobRequest extends Omit<
  app.StartJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Start one execution of a Container Apps job (any trigger type), optionally
 * overriding its containers. Returns the execution's name.
 *
 * Binding assigns a custom role (`AzureContainerAppsJobStartRole`, one per stack) with exactly
 * the action `Microsoft.App/jobs/start/action`, on the job only. The
 * smallest built-in role, **Container Apps Jobs Operator**, also reads the job and starts and stops its executions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartJobHttp}.
 *
 * ### Calling StartJob
 * **Example:** StartJob from a Function
 * ```typescript
 * const Nightly = Azure.ContainerApps.Job("Nightly", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const nightly = yield* Nightly;
 *     const startJob = yield* Azure.ContainerApps.StartJob(nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const execution = yield* startJob();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.StartJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "Azure.ContainerApps.StartJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: StartJobRequest,
    ) => Effect.Effect<app.JobExecutionBase, app.StartJobError, RuntimeContext>
  >
> {}

export const StartJob = Binding.Service<StartJob>("Azure.ContainerApps.StartJob");
