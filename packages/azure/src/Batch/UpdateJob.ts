import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateJobRequest extends Omit<batch.UpdateJobJobRequest, "endpoint"> {}

/**
 * Update a job's properties in place (`PATCH /jobs/{jobId}`; omitted properties keep their values) from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link UpdateJobHttp}.
 *
 * ### Calling UpdateJob
 * **Example:** UpdateJob from a Function
 * ```typescript
 * // init
 * const updateJob = yield* Azure.Batch.UpdateJob(account);
 *
 * // runtime
 * yield* updateJob({ jobId: "render-42", priority: 100 });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const updateJob = yield* Azure.Batch.UpdateJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.UpdateJobHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface UpdateJob extends Binding.Service<
  UpdateJob,
  "Azure.Batch.UpdateJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateJobRequest,
    ) => Effect.Effect<batch.UpdateJobJobResponse, batch.UpdateJobJobError, RuntimeContext>
  >
> {}

export const UpdateJob = Binding.Service<UpdateJob>("Azure.Batch.UpdateJob");
