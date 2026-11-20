import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:DeleteReport` — deletes a report of the
 * bound report group by report ARN.
 * ### Reading Reports
 * **Example:** Delete an Old Report
 * ```typescript
 * const deleteReport = yield* AWS.CodeBuild.DeleteReport(reportGroup);
 *
 * yield* deleteReport({ arn: reportArn });
 * ```
 *
 * @binding
 */
export interface DeleteReport extends Binding.Service<
  DeleteReport,
  "AWS.CodeBuild.DeleteReport",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (request: SVC.DeleteReportInput) => Effect.Effect<SVC.DeleteReportOutput, SVC.DeleteReportError>
  >
> {}
export const DeleteReport = Binding.Service<DeleteReport>("AWS.CodeBuild.DeleteReport");

export const DeleteReportHttp = Layer.effect(
  DeleteReport,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.DeleteReport",
    operation: codebuild.deleteReport,
    actions: ["codebuild:DeleteReport"],
  }),
);
