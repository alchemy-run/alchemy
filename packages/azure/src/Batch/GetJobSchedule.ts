import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetJobScheduleRequest extends Omit<
  batch.GetJobScheduleJobScheduleRequest,
  "endpoint"
> {}

/**
 * Read a job schedule (`GET /jobschedules/{jobScheduleId}`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadJobSchedulesRole` with exactly the data action `Microsoft.Batch/batchAccounts/jobSchedules/read`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetJobScheduleHttp}.
 *
 * ### Calling GetJobSchedule
 * **Example:** GetJobSchedule from a Function
 * ```typescript
 * // init
 * const getJobSchedule = yield* Azure.Batch.GetJobSchedule(account);
 *
 * // runtime
 * const schedule = yield* getJobSchedule({ jobScheduleId: "nightly" });
 * const next = schedule.executionInfo?.nextRunTime;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getJobSchedule = yield* Azure.Batch.GetJobSchedule(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.GetJobScheduleHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface GetJobSchedule extends Binding.Service<
  GetJobSchedule,
  "Azure.Batch.GetJobSchedule",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetJobScheduleRequest,
    ) => Effect.Effect<
      batch.GetJobScheduleJobScheduleResponse,
      batch.GetJobScheduleJobScheduleError,
      RuntimeContext
    >
  >
> {}

export const GetJobSchedule = Binding.Service<GetJobSchedule>("Azure.Batch.GetJobSchedule");
