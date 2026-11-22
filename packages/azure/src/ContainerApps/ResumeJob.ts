import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";

/** `ResumeJob` request without the job's identifiers, which the bound job supplies. */
export interface ResumeJobRequest extends Omit<
  app.ResumeJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Resume a suspended Container Apps job: its trigger starts executions again.
 *
 * Binding assigns a custom role (`AzureContainerAppsJobResumeRole`, one per stack) with exactly
 * the action `Microsoft.App/jobs/resume/action`, on the job only. The
 * smallest built-in role, **Container Apps Jobs Operator**, also reads the job and starts and stops its executions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ResumeJobHttp}.
 *
 * ### Calling ResumeJob
 * **Example:** ResumeJob from a Function
 * ```typescript
 * const Nightly = Azure.ContainerApps.Job("Nightly", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const nightly = yield* Nightly;
 *     const resume = yield* Azure.ContainerApps.ResumeJob(nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* resume();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.ResumeJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface ResumeJob extends Binding.Service<
  ResumeJob,
  "Azure.ContainerApps.ResumeJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: ResumeJobRequest,
    ) => Effect.Effect<app.ResumeJobResponse, app.ResumeJobError, RuntimeContext>
  >
> {}

export const ResumeJob = Binding.Service<ResumeJob>("Azure.ContainerApps.ResumeJob");
