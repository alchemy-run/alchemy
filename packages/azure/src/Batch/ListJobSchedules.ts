import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListJobSchedulesRequest extends Omit<
  batch.ListJobScheduleJobSchedulesRequest,
  "endpoint"
> {}

/**
 * List the job schedules of an Azure Batch account (`GET /jobschedules`, one page per call; pass the returned `odata_nextLink` as `nextLink` for the next page) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobSchedulesRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobSchedules/read`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ListJobSchedulesHttp}.
 *
 * ### Calling ListJobSchedules
 * **Example:** ListJobSchedules from a Function
 * ```typescript
 * // init
 * const listJobSchedules = yield* Azure.Batch.ListJobSchedules(account);
 *
 * // runtime
 * const page = yield* listJobSchedules();
 * const ids = page.value.map((schedule) => schedule.id);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const listJobSchedules = yield* Azure.Batch.ListJobSchedules(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.ListJobSchedulesHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface ListJobSchedules extends Binding.Service<
  ListJobSchedules,
  "Azure.Batch.ListJobSchedules",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListJobSchedulesRequest,
    ) => Effect.Effect<
      batch.BatchJobScheduleListResult,
      batch.ListJobScheduleJobSchedulesError,
      RuntimeContext
    >
  >
> {}

export const ListJobSchedules = Binding.Service<ListJobSchedules>("Azure.Batch.ListJobSchedules");
