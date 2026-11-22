import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { StreamingJob } from "./StreamingJob.ts";

/**
 * Shared scaffolding for the Stream Analytics runtime-action bindings: the
 * bound streaming job supplies `subscriptionId`, `resourceGroupName` and
 * `jobName`, and each binding assigns its custom role on the job only.
 *
 * NOT exported from `index.ts`.
 */

/** Stream Analytics permissions the bindings grant (Azure RBAC actions). */
export const StreamAnalyticsPermission = {
  start: "Microsoft.StreamAnalytics/streamingjobs/Start/action",
  stop: "Microsoft.StreamAnalytics/streamingjobs/Stop/action",
  scale: "Microsoft.StreamAnalytics/streamingjobs/Scale/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. Built-in
 * roles with these actions (e.g. **Contributor**) also edit the job.
 */
export const StreamAnalyticsRole = {
  StartStreamingJob: {
    role: "StreamAnalyticsStartStreamingJob",
    actions: [StreamAnalyticsPermission.start],
  },
  StopStreamingJob: {
    role: "StreamAnalyticsStopStreamingJob",
    actions: [StreamAnalyticsPermission.stop],
  },
  ScaleStreamingJob: {
    role: "StreamAnalyticsScaleStreamingJob",
    actions: [StreamAnalyticsPermission.scale],
  },
} as const satisfies Record<string, ArmActionRole>;

/**
 * Build the impl Effect for a streaming-job action: the runtime callable
 * fills the job's identifiers, and the deploy-time half assigns `role` on
 * the job.
 */
export const makeStreamingJobActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; jobName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.StreamAnalytics.StartStreamingJob`. */
  tag: string;
  /** The distilled `streamanalytics` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the streaming job. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (job: StreamingJob) => job.streamingJobId,
    target: (job) => job.streamingJobId,
    input: (request: Omit<I, "subscriptionId" | "resourceGroupName" | "jobName"> | undefined, id) =>
      ({ ...request, ...groupOf(id), jobName: id.names.streamingjobs ?? "" }) as I,
  });
