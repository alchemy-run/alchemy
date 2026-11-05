import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Analyzer } from "./Analyzer.ts";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";

/** `UpdateFindings` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface UpdateFindingsRequest extends Omit<aa.UpdateFindingsRequest, "analyzerArn"> {}

/**
 * Runtime binding for `access-analyzer:UpdateFindings`.
 *
 * Archives or reactivates findings by id or by the resource they were
 * generated for. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.UpdateFindingsHttp)`.
 * ### Managing Findings
 * **Example:** Archive Findings
 * ```typescript
 * const updateFindings = yield* AWS.AccessAnalyzer.UpdateFindings(analyzer);
 * yield* updateFindings({ status: "ARCHIVED", ids: [findingId] });
 * ```
 *
 * @binding
 */
export interface UpdateFindings extends Binding.Service<
  UpdateFindings,
  "AWS.AccessAnalyzer.UpdateFindings",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: UpdateFindingsRequest,
    ) => Effect.Effect<aa.UpdateFindingsResponse, aa.UpdateFindingsError>
  >
> {}

export const UpdateFindings = Binding.Service<UpdateFindings>("AWS.AccessAnalyzer.UpdateFindings");

export const UpdateFindingsHttp = Layer.effect(
  UpdateFindings,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.UpdateFindings",
    operation: aa.updateFindings,
    actions: ["access-analyzer:UpdateFindings"],
  }),
);
