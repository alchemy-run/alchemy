import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupArnHttpBinding } from "./BindingHttp.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:GetReportGroupTrend` — aggregates a trend
 * statistic (pass rate, duration, …) across the bound report group's most
 * recent reports.
 * ### Reading Reports
 * **Example:** Read the Pass-Rate Trend
 * ```typescript
 * const getReportGroupTrend = yield* AWS.CodeBuild.GetReportGroupTrend(reportGroup);
 *
 * const { stats } = yield* getReportGroupTrend({ trendField: "PASS_RATE" });
 * ```
 *
 * @binding
 */
export interface GetReportGroupTrend extends Binding.Service<
  GetReportGroupTrend,
  "AWS.CodeBuild.GetReportGroupTrend",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetReportGroupTrendInput, "reportGroupArn">,
    ) => Effect.Effect<SVC.GetReportGroupTrendOutput, SVC.GetReportGroupTrendError>
  >
> {}
export const GetReportGroupTrend = Binding.Service<GetReportGroupTrend>(
  "AWS.CodeBuild.GetReportGroupTrend",
);

export const GetReportGroupTrendHttp = Layer.effect(
  GetReportGroupTrend,
  makeCodeBuildReportGroupArnHttpBinding({
    tag: "AWS.CodeBuild.GetReportGroupTrend",
    operation: codebuild.getReportGroupTrend,
    actions: ["codebuild:GetReportGroupTrend"],
  }),
);
