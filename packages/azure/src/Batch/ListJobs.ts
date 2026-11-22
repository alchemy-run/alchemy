import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListJobsRequest extends Omit<batch.ListJobJobsRequest, "endpoint"> {}

/**
 * List the jobs of an Azure Batch account (`GET /jobs`, one page per call; pass the returned `odata_nextLink` as `nextLink` for the next page) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/read` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ListJobsHttp}.
 *
 * ### Calling ListJobs
 * **Example:** ListJobs from a Function
 * ```typescript
 * // init
 * const listJobs = yield* Azure.Batch.ListJobs(account);
 *
 * // runtime
 * const page = yield* listJobs({ _filter: "state eq 'active'" });
 * const ids = page.value.map((job) => job.id);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const listJobs = yield* Azure.Batch.ListJobs(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.ListJobsHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "Azure.Batch.ListJobs",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListJobsRequest,
    ) => Effect.Effect<batch.BatchJobListResult, batch.ListJobJobsError, RuntimeContext>
  >
> {}

export const ListJobs = Binding.Service<ListJobs>("Azure.Batch.ListJobs");
