import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";

export interface ListApplicationOperationsRequest extends Omit<
  SVC.ListApplicationOperationsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationOperations` — pages
 * through the bound application's async operation history (starts, stops,
 * updates, rollbacks and their outcomes).
 * ### Operating the Application
 * **Example:** List recent failed operations
 * ```typescript
 * const listOperations = yield* AWS.KinesisAnalyticsV2.ListApplicationOperations(app);
 *
 * const { ApplicationOperationInfoList } = yield* listOperations({
 *   OperationStatus: "FAILED",
 * });
 * ```
 *
 * @binding
 */
export interface ListApplicationOperations extends Binding.Service<
  ListApplicationOperations,
  "AWS.KinesisAnalyticsV2.ListApplicationOperations",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationOperationsRequest,
    ) => Effect.Effect<SVC.ListApplicationOperationsResponse, SVC.ListApplicationOperationsError>
  >
> {}
export const ListApplicationOperations = Binding.Service<ListApplicationOperations>(
  "AWS.KinesisAnalyticsV2.ListApplicationOperations",
);

export const ListApplicationOperationsHttp = Layer.effect(
  ListApplicationOperations,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplicationOperations",
    operation: analytics.listApplicationOperations,
    actions: ["kinesisanalytics:ListApplicationOperations"],
  }),
);
