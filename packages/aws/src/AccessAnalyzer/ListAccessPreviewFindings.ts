import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Analyzer } from "./Analyzer.ts";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";

/** `ListAccessPreviewFindings` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListAccessPreviewFindingsRequest extends Omit<
  aa.ListAccessPreviewFindingsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ListAccessPreviewFindings`.
 *
 * Lists the findings a completed access preview produced. Provide the
 * implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListAccessPreviewFindingsHttp)`.
 * ### Access Previews
 * **Example:** Read Preview Findings
 * ```typescript
 * const listPreviewFindings =
 *   yield* AWS.AccessAnalyzer.ListAccessPreviewFindings(analyzer);
 * const page = yield* listPreviewFindings({ accessPreviewId });
 * ```
 *
 * @binding
 */
export interface ListAccessPreviewFindings extends Binding.Service<
  ListAccessPreviewFindings,
  "AWS.AccessAnalyzer.ListAccessPreviewFindings",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: ListAccessPreviewFindingsRequest,
    ) => Effect.Effect<aa.ListAccessPreviewFindingsResponse, aa.ListAccessPreviewFindingsError>
  >
> {}

export const ListAccessPreviewFindings = Binding.Service<ListAccessPreviewFindings>(
  "AWS.AccessAnalyzer.ListAccessPreviewFindings",
);

export const ListAccessPreviewFindingsHttp = Layer.effect(
  ListAccessPreviewFindings,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListAccessPreviewFindings",
    operation: aa.listAccessPreviewFindings,
    actions: ["access-analyzer:ListAccessPreviewFindings"],
  }),
);
