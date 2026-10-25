import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TerminateTaskRequest extends Omit<batch.TerminateTaskTaskRequest, "endpoint"> {}

/**
 * Terminate a task (`POST /jobs/{jobId}/tasks/{taskId}/terminate`); a running task is stopped and the task completes from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link TerminateTaskHttp}.
 *
 * ### Calling TerminateTask
 * **Example:** TerminateTask from a Function
 * ```typescript
 * // init
 * const terminateTask = yield* Azure.Batch.TerminateTask(account);
 *
 * // runtime
 * yield* terminateTask({ jobId: "render-42", taskId: "frame-1" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const terminateTask = yield* Azure.Batch.TerminateTask(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.TerminateTaskHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface TerminateTask extends Binding.Service<
  TerminateTask,
  "Azure.Batch.TerminateTask",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TerminateTaskRequest,
    ) => Effect.Effect<
      batch.TerminateTaskTaskResponse,
      batch.TerminateTaskTaskError,
      RuntimeContext
    >
  >
> {}

export const TerminateTask = Binding.Service<TerminateTask>("Azure.Batch.TerminateTask");
