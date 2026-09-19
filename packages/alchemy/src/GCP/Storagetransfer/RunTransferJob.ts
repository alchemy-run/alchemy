import type * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { TransferJob } from "./TransferJob.ts";

export interface RunTransferJobRequest extends Omit<
  storagetransfer.RunTransferJobsRequest,
  "jobName"
> {}

/**
 * Runtime binding for Storage Transfer `transferJobs.run`.
 *
 * Starts a transfer operation immediately, even when the job has no
 * schedule. Bind this operation to a {@link TransferJob} in a
 * Function/Action init phase. Provide {@link RunTransferJobHttp}.
 *
 * ### Running Transfer Jobs
 * **Example:** Run the bound job now
 * ```typescript
 * const runJob = yield* GCP.Storagetransfer.RunTransferJob(nightly);
 * const operation = yield* runJob();
 * ```
 *
 * @binding
 * @product GCP
 * @category Storagetransfer
 */
export interface RunTransferJob extends Binding.Service<
  RunTransferJob,
  "GCP.Storagetransfer.RunTransferJob",
  (
    job: TransferJob,
  ) => Effect.Effect<
    (
      request?: RunTransferJobRequest,
    ) => Effect.Effect<
      storagetransfer.Operation,
      storagetransfer.RunTransferJobsError,
      RuntimeContext
    >
  >
> {}

export const RunTransferJob = Binding.Service<RunTransferJob>(
  "GCP.Storagetransfer.RunTransferJob",
);
