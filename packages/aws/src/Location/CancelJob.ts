import * as location from "@distilled.cloud/aws/location";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocationAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Cancels a running Location batch metadata job.
 *
 * Runtime binding for the `CancelJob` operation (IAM action
 * `geo:CancelJob`), account-scoped — batch jobs are created at runtime so the
 * grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.CancelJobHttp)`.
 *
 * ### Managing Batch Jobs
 * **Example:** Cancel a Batch Job
 * ```typescript
 * const cancelJob = yield* Location.CancelJob();
 *
 * yield* cancelJob({ JobId: jobId });
 * ```
 *
 * @binding
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.Location.CancelJob",
  () => Effect.Effect<
    (
      request: location.CancelJobRequest,
    ) => Effect.Effect<location.CancelJobResponse, location.CancelJobError>
  >
> {}
export const CancelJob = Binding.Service<CancelJob>("AWS.Location.CancelJob");

export const CancelJobHttp = Layer.effect(
  CancelJob,
  makeLocationAccountHttpBinding({
    tag: "AWS.Location.CancelJob",
    operation: location.cancelJob,
    actions: ["geo:CancelJob"],
  }),
);
