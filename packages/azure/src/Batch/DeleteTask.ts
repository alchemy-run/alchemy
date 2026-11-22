import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteTaskRequest extends Omit<batch.DeleteTaskTaskRequest, "endpoint"> {}

/**
 * Delete a task from a job (`DELETE /jobs/{jobId}/tasks/{taskId}`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchDeleteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/delete` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link DeleteTaskHttp}.
 *
 * ### Calling DeleteTask
 * **Example:** DeleteTask from a Function
 * ```typescript
 * // init
 * const deleteTask = yield* Azure.Batch.DeleteTask(account);
 *
 * // runtime
 * yield* deleteTask({ jobId: "render-42", taskId: "frame-1" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const deleteTask = yield* Azure.Batch.DeleteTask(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.DeleteTaskHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface DeleteTask extends Binding.Service<
  DeleteTask,
  "Azure.Batch.DeleteTask",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteTaskRequest,
    ) => Effect.Effect<batch.DeleteTaskTaskResponse, batch.DeleteTaskTaskError, RuntimeContext>
  >
> {}

export const DeleteTask = Binding.Service<DeleteTask>("Azure.Batch.DeleteTask");
