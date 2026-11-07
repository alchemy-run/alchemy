import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";

export interface ListApplicationVersionsRequest extends Omit<
  SVC.ListApplicationVersionsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationVersions` — pages
 * through the bound application's version history (every configuration
 * update creates a version), e.g. to pick a rollback target.
 * ### Observing the Application
 * **Example:** List recent versions
 * ```typescript
 * const listVersions = yield* AWS.KinesisAnalyticsV2.ListApplicationVersions(app);
 *
 * const { ApplicationVersionSummaries } = yield* listVersions({ Limit: 10 });
 * ```
 *
 * @binding
 */
export interface ListApplicationVersions extends Binding.Service<
  ListApplicationVersions,
  "AWS.KinesisAnalyticsV2.ListApplicationVersions",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationVersionsRequest,
    ) => Effect.Effect<SVC.ListApplicationVersionsResponse, SVC.ListApplicationVersionsError>
  >
> {}
export const ListApplicationVersions = Binding.Service<ListApplicationVersions>(
  "AWS.KinesisAnalyticsV2.ListApplicationVersions",
);

export const ListApplicationVersionsHttp = Layer.effect(
  ListApplicationVersions,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplicationVersions",
    operation: analytics.listApplicationVersions,
    actions: ["kinesisanalytics:ListApplicationVersions"],
  }),
);
