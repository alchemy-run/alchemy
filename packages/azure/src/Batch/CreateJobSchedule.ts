import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateJobScheduleRequest extends Omit<
  batch.CreateJobScheduleJobScheduleRequest,
  "endpoint"
> {}

/**
 * Create a job schedule that creates jobs on a recurrence (`POST /jobschedules`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchWriteJobSchedulesRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobSchedules/write`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link CreateJobScheduleHttp}.
 *
 * ### Calling CreateJobSchedule
 * **Example:** CreateJobSchedule from a Function
 * ```typescript
 * // init
 * const createJobSchedule = yield* Azure.Batch.CreateJobSchedule(account);
 *
 * // runtime
 * yield* createJobSchedule({
 *   id: "nightly",
 *   schedule: { recurrenceInterval: "P1D" },
 *   jobSpecification: { poolInfo: { poolId: pool.poolName } },
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const createJobSchedule = yield* Azure.Batch.CreateJobSchedule(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.CreateJobScheduleHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface CreateJobSchedule extends Binding.Service<
  CreateJobSchedule,
  "Azure.Batch.CreateJobSchedule",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateJobScheduleRequest,
    ) => Effect.Effect<
      batch.CreateJobScheduleJobScheduleResponse,
      batch.CreateJobScheduleJobScheduleError,
      RuntimeContext
    >
  >
> {}

export const CreateJobSchedule = Binding.Service<CreateJobSchedule>(
  "Azure.Batch.CreateJobSchedule",
);
