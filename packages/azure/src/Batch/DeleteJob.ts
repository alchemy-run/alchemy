import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteJobRequest extends Omit<batch.DeleteJobJobRequest, "endpoint"> {}

/**
 * Delete a job and its tasks (`DELETE /jobs/{jobId}`; the job is `deleting` until Batch finishes) from any host.
 *
 * Binding assigns a custom role (`AzureBatchDeleteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/delete` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link DeleteJobHttp}.
 *
 * ### Calling DeleteJob
 * **Example:** DeleteJob from a Function
 * ```typescript
 * // init
 * const deleteJob = yield* Azure.Batch.DeleteJob(account);
 *
 * // runtime
 * yield* deleteJob({ jobId: "render-42" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const deleteJob = yield* Azure.Batch.DeleteJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.DeleteJobHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface DeleteJob extends Binding.Service<
  DeleteJob,
  "Azure.Batch.DeleteJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteJobRequest,
    ) => Effect.Effect<batch.DeleteJobJobResponse, batch.DeleteJobJobError, RuntimeContext>
  >
> {}

export const DeleteJob = Binding.Service<DeleteJob>("Azure.Batch.DeleteJob");
