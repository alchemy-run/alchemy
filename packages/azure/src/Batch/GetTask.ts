import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetTaskRequest extends Omit<batch.GetTaskTaskRequest, "endpoint"> {}

/**
 * Read a task of a job (`GET /jobs/{jobId}/tasks/{taskId}`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/read` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetTaskHttp}.
 *
 * ### Calling GetTask
 * **Example:** GetTask from a Function
 * ```typescript
 * // init
 * const getTask = yield* Azure.Batch.GetTask(account);
 *
 * // runtime
 * const task = yield* getTask({ jobId: "render-42", taskId: "frame-1" });
 * const exitCode = task.executionInfo?.exitCode;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getTask = yield* Azure.Batch.GetTask(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.GetTaskHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface GetTask extends Binding.Service<
  GetTask,
  "Azure.Batch.GetTask",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetTaskRequest,
    ) => Effect.Effect<batch.GetTaskTaskResponse, batch.GetTaskTaskError, RuntimeContext>
  >
> {}

export const GetTask = Binding.Service<GetTask>("Azure.Batch.GetTask");
