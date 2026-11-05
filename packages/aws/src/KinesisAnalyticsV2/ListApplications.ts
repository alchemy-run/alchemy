import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListApplications}.
 */
export interface ListApplicationsRequest extends SVC.ListApplicationsRequest {}

/**
 * Runtime binding for `kinesisanalytics:ListApplications`.
 *
 * An account-level operation (no application argument) that pages through
 * the account's Managed Service for Apache Flink applications — name, ARN,
 * and status for each. Useful for fleet dashboards and governance sweeps
 * that audit which applications exist and whether they are RUNNING.
 * Provide the implementation with
 * `Effect.provide(AWS.KinesisAnalyticsV2.ListApplicationsHttp)`.
 * ### Inspecting the Application
 * **Example:** List the Account's Applications
 * ```typescript
 * // init — account-level binding takes no resource
 * const listApplications = yield* AWS.KinesisAnalyticsV2.ListApplications();
 *
 * // runtime
 * const { ApplicationSummaries } = yield* listApplications({ Limit: 50 });
 * const running = (ApplicationSummaries ?? []).filter(
 *   (app) => app.ApplicationStatus === "RUNNING",
 * );
 * ```
 *
 * @binding
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "AWS.KinesisAnalyticsV2.ListApplications",
  () => Effect.Effect<
    (
      request?: ListApplicationsRequest,
    ) => Effect.Effect<SVC.ListApplicationsResponse, SVC.ListApplicationsError>
  >
> {}
export const ListApplications = Binding.Service<ListApplications>(
  "AWS.KinesisAnalyticsV2.ListApplications",
);

export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeKinesisAnalyticsAccountHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplications",
    operation: analytics.listApplications,
    actions: ["kinesisanalytics:ListApplications"],
  }),
);
