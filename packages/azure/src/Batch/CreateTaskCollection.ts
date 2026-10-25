import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateTaskCollectionRequest extends Omit<
  batch.CreateTaskTaskCollectionRequest,
  "endpoint"
> {}

/**
 * Add up to 100 tasks to a job in one call (`POST /jobs/{jobId}/addtaskcollection`); each task reports its own status from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobsRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobs/write` (tasks are part of their job), one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link CreateTaskCollectionHttp}.
 *
 * ### Calling CreateTaskCollection
 * **Example:** CreateTaskCollection from a Function
 * ```typescript
 * // init
 * const createTasks = yield* Azure.Batch.CreateTaskCollection(account);
 *
 * // runtime
 * const result = yield* createTasks({
 *   jobId: "render-42",
 *   value: [
 *     { id: "frame-1", commandLine: "/bin/sh -c 'echo 1'" },
 *     { id: "frame-2", commandLine: "/bin/sh -c 'echo 2'" },
 *   ],
 * });
 * const failed = (result.value ?? []).filter((task) => task.status !== "Success");
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const createTasks = yield* Azure.Batch.CreateTaskCollection(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.CreateTaskCollectionHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface CreateTaskCollection extends Binding.Service<
  CreateTaskCollection,
  "Azure.Batch.CreateTaskCollection",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateTaskCollectionRequest,
    ) => Effect.Effect<
      batch.BatchCreateTaskCollectionResult,
      batch.CreateTaskTaskCollectionError,
      RuntimeContext
    >
  >
> {}

export const CreateTaskCollection = Binding.Service<CreateTaskCollection>(
  "Azure.Batch.CreateTaskCollection",
);
