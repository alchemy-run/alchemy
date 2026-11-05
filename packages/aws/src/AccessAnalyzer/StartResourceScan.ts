import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Analyzer } from "./Analyzer.ts";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";

/** `StartResourceScan` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface StartResourceScanRequest extends Omit<
  aa.StartResourceScanRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:StartResourceScan`.
 *
 * Immediately rescans a resource's policy instead of waiting for the
 * analyzer's periodic scan. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.StartResourceScanHttp)`.
 * ### Scanning Resources
 * **Example:** Rescan a Bucket After a Policy Change
 * ```typescript
 * const startScan = yield* AWS.AccessAnalyzer.StartResourceScan(analyzer);
 * yield* startScan({ resourceArn: bucket.bucketArn });
 * ```
 *
 * @binding
 */
export interface StartResourceScan extends Binding.Service<
  StartResourceScan,
  "AWS.AccessAnalyzer.StartResourceScan",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: StartResourceScanRequest,
    ) => Effect.Effect<aa.StartResourceScanResponse, aa.StartResourceScanError>
  >
> {}

export const StartResourceScan = Binding.Service<StartResourceScan>(
  "AWS.AccessAnalyzer.StartResourceScan",
);

export const StartResourceScanHttp = Layer.effect(
  StartResourceScan,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.StartResourceScan",
    operation: aa.startResourceScan,
    actions: ["access-analyzer:StartResourceScan"],
  }),
);
