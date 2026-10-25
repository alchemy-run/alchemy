import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateTaskRequest extends Omit<batch.CreateTaskTaskRequest, "endpoint"> {}

/**
 * Add a task to a job (`POST /jobs/{jobId}/tasks`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link CreateTaskHttp}.
 *
 * ### Calling CreateTask
 * **Example:** CreateTask from a Function
 * ```typescript
 * // init
 * const createTask = yield* Azure.Batch.CreateTask(account);
 *
 * // runtime
 * yield* createTask({
 *   jobId: "render-42",
 *   id: "frame-1",
 *   commandLine: "/bin/sh -c 'echo frame 1'",
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const createTask = yield* Azure.Batch.CreateTask(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.CreateTaskHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface CreateTask extends Binding.Service<
  CreateTask,
  "Azure.Batch.CreateTask",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateTaskRequest,
    ) => Effect.Effect<batch.CreateTaskTaskResponse, batch.CreateTaskTaskError, RuntimeContext>
  >
> {}

export const CreateTask = Binding.Service<CreateTask>("Azure.Batch.CreateTask");
