import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Analyzer } from "./Analyzer.ts";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";

/** `ListFindingsV2` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListFindingsV2Request extends Omit<aa.ListFindingsV2Request, "analyzerArn"> {}

/**
 * Runtime binding for the `ListFindingsV2` operation (IAM action
 * `access-analyzer:ListFindings` — shared with the V1 API).
 *
 * Lists the analyzer's findings (external-access and unused-access), with
 * optional filter and sort criteria. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListFindingsV2Http)`.
 * ### Reading Findings
 * **Example:** List Active Findings
 * ```typescript
 * // init — bind the operation to the analyzer
 * const listFindings = yield* AWS.AccessAnalyzer.ListFindingsV2(analyzer);
 *
 * // runtime — page through active findings
 * const page = yield* listFindings({
 *   filter: { status: { eq: ["ACTIVE"] } },
 *   maxResults: 50,
 * });
 * ```
 *
 * @binding
 */
export interface ListFindingsV2 extends Binding.Service<
  ListFindingsV2,
  "AWS.AccessAnalyzer.ListFindingsV2",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: ListFindingsV2Request,
    ) => Effect.Effect<aa.ListFindingsV2Response, aa.ListFindingsV2Error>
  >
> {}

export const ListFindingsV2 = Binding.Service<ListFindingsV2>("AWS.AccessAnalyzer.ListFindingsV2");

export const ListFindingsV2Http = Layer.effect(
  ListFindingsV2,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListFindingsV2",
    operation: aa.listFindingsV2,
    // ListFindings and ListFindingsV2 both use `access-analyzer:ListFindings`.
    actions: ["access-analyzer:ListFindings"],
  }),
);
