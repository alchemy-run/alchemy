import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TerminateJobRequest extends Omit<batch.TerminateJobJobRequest, "endpoint"> {}

/**
 * Terminate a job, ending its running tasks (`POST /jobs/{jobId}/terminate`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link TerminateJobHttp}.
 *
 * ### Calling TerminateJob
 * **Example:** TerminateJob from a Function
 * ```typescript
 * // init
 * const terminateJob = yield* Azure.Batch.TerminateJob(account);
 *
 * // runtime
 * yield* terminateJob({ jobId: "render-42", terminateReason: "cancelled" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const terminateJob = yield* Azure.Batch.TerminateJob(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.TerminateJobHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface TerminateJob extends Binding.Service<
  TerminateJob,
  "Azure.Batch.TerminateJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TerminateJobRequest,
    ) => Effect.Effect<batch.TerminateJobJobResponse, batch.TerminateJobJobError, RuntimeContext>
  >
> {}

export const TerminateJob = Binding.Service<TerminateJob>("Azure.Batch.TerminateJob");
