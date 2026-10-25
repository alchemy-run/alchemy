import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetJobTaskCountsRequest extends Omit<
  batch.GetJobJobTaskCountsRequest,
  "endpoint"
> {}

/**
 * Count a job's tasks and slots by state (`GET /jobs/{jobId}/taskcounts`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/read` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetJobTaskCountsHttp}.
 *
 * ### Calling GetJobTaskCounts
 * **Example:** GetJobTaskCounts from a Function
 * ```typescript
 * // init
 * const getJobTaskCounts = yield* Azure.Batch.GetJobTaskCounts(account);
 *
 * // runtime
 * const counts = yield* getJobTaskCounts({ jobId: "render-42" });
 * const pending = counts.taskCounts.active;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getJobTaskCounts = yield* Azure.Batch.GetJobTaskCounts(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.GetJobTaskCountsHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface GetJobTaskCounts extends Binding.Service<
  GetJobTaskCounts,
  "Azure.Batch.GetJobTaskCounts",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetJobTaskCountsRequest,
    ) => Effect.Effect<batch.BatchTaskCountsResult, batch.GetJobJobTaskCountsError, RuntimeContext>
  >
> {}

export const GetJobTaskCounts = Binding.Service<GetJobTaskCounts>("Azure.Batch.GetJobTaskCounts");
