import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateJobRequest extends Omit<batch.CreateJobJobRequest, "endpoint"> {}

/**
 * Create a job in an Azure Batch account (`POST /jobs`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link CreateJobHttp}.
 *
 * ### Calling CreateJob
 * **Example:** CreateJob from a Function
 * ```typescript
 * // init
 * const createJob = yield* Azure.Batch.CreateJob(account);
 *
 * // runtime
 * yield* createJob({
 *   id: "render-42",
 *   poolInfo: { poolId: pool.poolName },
 *   onAllTasksComplete: "terminatejob",
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const createJob = yield* Azure.Batch.CreateJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.CreateJobHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "Azure.Batch.CreateJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateJobRequest,
    ) => Effect.Effect<batch.CreateJobJobResponse, batch.CreateJobJobError, RuntimeContext>
  >
> {}

export const CreateJob = Binding.Service<CreateJob>("Azure.Batch.CreateJob");
