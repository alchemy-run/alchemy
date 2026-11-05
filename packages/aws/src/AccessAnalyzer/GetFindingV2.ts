import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Analyzer } from "./Analyzer.ts";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";

/** `GetFindingV2` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetFindingV2Request extends Omit<aa.GetFindingV2Request, "analyzerArn"> {}

/**
 * Runtime binding for the `GetFindingV2` operation (IAM action
 * `access-analyzer:GetFinding` — shared with the V1 API).
 *
 * Retrieves a single finding with its typed `findingDetails` (external-access
 * or unused-access). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetFindingV2Http)`.
 * ### Reading Findings
 * **Example:** Get a Finding by Id
 * ```typescript
 * const getFinding = yield* AWS.AccessAnalyzer.GetFindingV2(analyzer);
 * const finding = yield* getFinding({ id: findingId });
 * ```
 *
 * @binding
 */
export interface GetFindingV2 extends Binding.Service<
  GetFindingV2,
  "AWS.AccessAnalyzer.GetFindingV2",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (request: GetFindingV2Request) => Effect.Effect<aa.GetFindingV2Response, aa.GetFindingV2Error>
  >
> {}

export const GetFindingV2 = Binding.Service<GetFindingV2>("AWS.AccessAnalyzer.GetFindingV2");

export const GetFindingV2Http = Layer.effect(
  GetFindingV2,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GetFindingV2",
    operation: aa.getFindingV2,
    // GetFinding and GetFindingV2 both use `access-analyzer:GetFinding`.
    actions: ["access-analyzer:GetFinding"],
  }),
);
