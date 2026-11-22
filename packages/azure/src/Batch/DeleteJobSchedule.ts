import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteJobScheduleRequest extends Omit<
  batch.DeleteJobScheduleJobScheduleRequest,
  "endpoint"
> {}

/**
 * Delete a job schedule and the jobs it created (`DELETE /jobschedules/{jobScheduleId}`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchDeleteJobSchedulesRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobSchedules/delete`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link DeleteJobScheduleHttp}.
 *
 * ### Calling DeleteJobSchedule
 * **Example:** DeleteJobSchedule from a Function
 * ```typescript
 * // init
 * const deleteJobSchedule = yield* Azure.Batch.DeleteJobSchedule(account);
 *
 * // runtime
 * yield* deleteJobSchedule({ jobScheduleId: "nightly" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const deleteJobSchedule = yield* Azure.Batch.DeleteJobSchedule(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.DeleteJobScheduleHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface DeleteJobSchedule extends Binding.Service<
  DeleteJobSchedule,
  "Azure.Batch.DeleteJobSchedule",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteJobScheduleRequest,
    ) => Effect.Effect<
      batch.DeleteJobScheduleJobScheduleResponse,
      batch.DeleteJobScheduleJobScheduleError,
      RuntimeContext
    >
  >
> {}

export const DeleteJobSchedule = Binding.Service<DeleteJobSchedule>(
  "Azure.Batch.DeleteJobSchedule",
);
