import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";

/** `SuspendJob` request without the job's identifiers, which the bound job supplies. */
export interface SuspendJobRequest extends Omit<
  app.SuspendJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Suspend a Container Apps job: its schedule or event trigger stops starting
 * executions until `ResumeJob`.
 *
 * Binding assigns a custom role (`AzureContainerAppsJobSuspendRole`, one per stack) with exactly
 * the action `Microsoft.App/jobs/suspend/action`, on the job only. The
 * smallest built-in role, **Container Apps Jobs Operator**, also reads the job and starts and stops its executions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SuspendJobHttp}.
 *
 * ### Calling SuspendJob
 * **Example:** SuspendJob from a Function
 * ```typescript
 * const Nightly = Azure.ContainerApps.Job("Nightly", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const nightly = yield* Nightly;
 *     const suspend = yield* Azure.ContainerApps.SuspendJob(nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* suspend();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.SuspendJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface SuspendJob extends Binding.Service<
  SuspendJob,
  "Azure.ContainerApps.SuspendJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: SuspendJobRequest,
    ) => Effect.Effect<app.SuspendJobResponse, app.SuspendJobError, RuntimeContext>
  >
> {}

export const SuspendJob = Binding.Service<SuspendJob>("Azure.ContainerApps.SuspendJob");
