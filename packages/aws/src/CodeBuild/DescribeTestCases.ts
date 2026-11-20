import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:DescribeTestCases` — reads the individual
 * test cases of a test report in the bound report group.
 * ### Reading Reports
 * **Example:** Read Failed Test Cases
 * ```typescript
 * const describeTestCases = yield* AWS.CodeBuild.DescribeTestCases(reportGroup);
 *
 * const { testCases } = yield* describeTestCases({
 *   reportArn,
 *   filter: { status: "FAILED" },
 * });
 * ```
 *
 * @binding
 */
export interface DescribeTestCases extends Binding.Service<
  DescribeTestCases,
  "AWS.CodeBuild.DescribeTestCases",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: SVC.DescribeTestCasesInput,
    ) => Effect.Effect<SVC.DescribeTestCasesOutput, SVC.DescribeTestCasesError>
  >
> {}
export const DescribeTestCases = Binding.Service<DescribeTestCases>(
  "AWS.CodeBuild.DescribeTestCases",
);

export const DescribeTestCasesHttp = Layer.effect(
  DescribeTestCases,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.DescribeTestCases",
    operation: codebuild.describeTestCases,
    actions: ["codebuild:DescribeTestCases"],
  }),
);
