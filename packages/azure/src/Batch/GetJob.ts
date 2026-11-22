import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetJobRequest extends Omit<batch.GetJobJobRequest, "endpoint"> {}

/**
 * Read a job of an Azure Batch account (`GET /jobs/{jobId}`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/read` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetJobHttp}.
 *
 * ### Calling GetJob
 * **Example:** GetJob from a Function
 * ```typescript
 * // init
 * const getJob = yield* Azure.Batch.GetJob(account);
 *
 * // runtime
 * const job = yield* getJob({ jobId: "render-42" });
 * const state = job.state;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getJob = yield* Azure.Batch.GetJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.GetJobHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "Azure.Batch.GetJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetJobRequest,
    ) => Effect.Effect<batch.GetJobJobResponse, batch.GetJobJobError, RuntimeContext>
  >
> {}

export const GetJob = Binding.Service<GetJob>("Azure.Batch.GetJob");
