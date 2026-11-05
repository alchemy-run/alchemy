import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";

export interface DescribeApplicationVersionRequest extends Omit<
  SVC.DescribeApplicationVersionRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DescribeApplicationVersion` — reads
 * the configuration of a specific version of the bound application, e.g. to
 * inspect what a rollback target looked like.
 * ### Observing the Application
 * **Example:** Inspect a historical version
 * ```typescript
 * const describeVersion = yield* AWS.KinesisAnalyticsV2.DescribeApplicationVersion(app);
 *
 * const { ApplicationVersionDetail } = yield* describeVersion({
 *   ApplicationVersionId: 3,
 * });
 * ```
 *
 * @binding
 */
export interface DescribeApplicationVersion extends Binding.Service<
  DescribeApplicationVersion,
  "AWS.KinesisAnalyticsV2.DescribeApplicationVersion",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: DescribeApplicationVersionRequest,
    ) => Effect.Effect<SVC.DescribeApplicationVersionResponse, SVC.DescribeApplicationVersionError>
  >
> {}
export const DescribeApplicationVersion = Binding.Service<DescribeApplicationVersion>(
  "AWS.KinesisAnalyticsV2.DescribeApplicationVersion",
);

export const DescribeApplicationVersionHttp = Layer.effect(
  DescribeApplicationVersion,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.DescribeApplicationVersion",
    operation: analytics.describeApplicationVersion,
    actions: ["kinesisanalytics:DescribeApplicationVersion"],
  }),
);
