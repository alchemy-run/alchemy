import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";

export interface StopApplicationRequest extends Omit<
  SVC.StopApplicationRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:StopApplication` — stops the bound
 * Flink application. By default the job is stopped gracefully (taking a
 * snapshot when snapshots are enabled); `Force: true` skips the snapshot.
 * ### Operating the Application
 * **Example:** Force-stop the Flink job
 * ```typescript
 * const stopApplication = yield* AWS.KinesisAnalyticsV2.StopApplication(app);
 *
 * const { OperationId } = yield* stopApplication({ Force: true });
 * ```
 *
 * @binding
 */
export interface StopApplication extends Binding.Service<
  StopApplication,
  "AWS.KinesisAnalyticsV2.StopApplication",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: StopApplicationRequest,
    ) => Effect.Effect<SVC.StopApplicationResponse, SVC.StopApplicationError>
  >
> {}
export const StopApplication = Binding.Service<StopApplication>(
  "AWS.KinesisAnalyticsV2.StopApplication",
);

export const StopApplicationHttp = Layer.effect(
  StopApplication,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.StopApplication",
    operation: analytics.stopApplication,
    actions: ["kinesisanalytics:StopApplication"],
  }),
);
