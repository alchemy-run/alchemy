import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:StartJob`.
 *
 * Starts a created job. Jobs are created in the `WAITING` state and do
 * nothing until started.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.StartJobHttp)`.
 * @binding
 * @section Import & Export Jobs
 * @example Start A Created Job
 * ```typescript
 * const startJob = yield* AWS.DataExchange.StartJob();
 *
 * // runtime
 * yield* startJob({ JobId: job.Id! });
 * ```
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.DataExchange.StartJob",
  () => Effect.Effect<
    (
      request: dataexchange.StartJobRequest,
    ) => Effect.Effect<
      dataexchange.StartJobResponse,
      dataexchange.StartJobError
    >
  >
> {}
export const StartJob = Binding.Service<StartJob>("AWS.DataExchange.StartJob");
