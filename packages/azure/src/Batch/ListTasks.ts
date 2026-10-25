import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListTasksRequest extends Omit<batch.ListTaskTasksRequest, "endpoint"> {}

/**
 * List the tasks of a job (`GET /jobs/{jobId}/tasks`, one page per call; pass the returned `odata_nextLink` as `nextLink` for the next page) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/read` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ListTasksHttp}.
 *
 * ### Calling ListTasks
 * **Example:** ListTasks from a Function
 * ```typescript
 * // init
 * const listTasks = yield* Azure.Batch.ListTasks(account);
 *
 * // runtime
 * const page = yield* listTasks({ jobId: "render-42", _filter: "state eq 'completed'" });
 * const ids = page.value.map((task) => task.id);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const listTasks = yield* Azure.Batch.ListTasks(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.ListTasksHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface ListTasks extends Binding.Service<
  ListTasks,
  "Azure.Batch.ListTasks",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListTasksRequest,
    ) => Effect.Effect<batch.BatchTaskListResult, batch.ListTaskTasksError, RuntimeContext>
  >
> {}

export const ListTasks = Binding.Service<ListTasks>("Azure.Batch.ListTasks");
