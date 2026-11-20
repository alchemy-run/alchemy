import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";

export interface CreateApplicationSnapshotRequest extends Omit<
  SVC.CreateApplicationSnapshotRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:CreateApplicationSnapshot` — takes
 * a snapshot (Flink savepoint) of the bound application's state on demand,
 * e.g. a scheduled backup ahead of a deploy. The application must be
 * `RUNNING` with snapshots enabled; poll the result with
 * {@link DescribeApplicationSnapshot}.
 * ### Managing Snapshots
 * **Example:** Take a savepoint before a deploy
 * ```typescript
 * const createSnapshot = yield* AWS.KinesisAnalyticsV2.CreateApplicationSnapshot(app);
 *
 * yield* createSnapshot({ SnapshotName: "pre-deploy" });
 * ```
 *
 * @binding
 */
export interface CreateApplicationSnapshot extends Binding.Service<
  CreateApplicationSnapshot,
  "AWS.KinesisAnalyticsV2.CreateApplicationSnapshot",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: CreateApplicationSnapshotRequest,
    ) => Effect.Effect<SVC.CreateApplicationSnapshotResponse, SVC.CreateApplicationSnapshotError>
  >
> {}
export const CreateApplicationSnapshot = Binding.Service<CreateApplicationSnapshot>(
  "AWS.KinesisAnalyticsV2.CreateApplicationSnapshot",
);

export const CreateApplicationSnapshotHttp = Layer.effect(
  CreateApplicationSnapshot,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.CreateApplicationSnapshot",
    operation: analytics.createApplicationSnapshot,
    actions: ["kinesisanalytics:CreateApplicationSnapshot"],
  }),
);
