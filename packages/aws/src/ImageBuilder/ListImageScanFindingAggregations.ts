import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `imagebuilder:ListImageScanFindingAggregations`.
 *
 * Returns Amazon Inspector finding counts grouped by severity — for the
 * whole account, or grouped by one key (`imagePipelineArn`,
 * `imageBuildVersionArn`, `accountId`, `vulnerabilityId`) when a filter is
 * supplied. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImageScanFindingAggregationsHttp)`.
 * ### Scan Findings
 * **Example:** Aggregate Findings by Pipeline
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImageScanFindingAggregations =
 *   yield* AWS.ImageBuilder.ListImageScanFindingAggregations();
 *
 * // runtime
 * const { responses } = yield* listImageScanFindingAggregations({
 *   filter: { name: "imagePipelineArn", values: [pipelineArn] },
 * });
 * ```
 *
 * @binding
 */
export interface ListImageScanFindingAggregations extends Binding.Service<
  ListImageScanFindingAggregations,
  "AWS.ImageBuilder.ListImageScanFindingAggregations",
  () => Effect.Effect<
    (
      request?: imagebuilder.ListImageScanFindingAggregationsRequest,
    ) => Effect.Effect<
      imagebuilder.ListImageScanFindingAggregationsResponse,
      imagebuilder.ListImageScanFindingAggregationsError
    >
  >
> {}
export const ListImageScanFindingAggregations = Binding.Service<ListImageScanFindingAggregations>(
  "AWS.ImageBuilder.ListImageScanFindingAggregations",
);

export const ListImageScanFindingAggregationsHttp = Layer.effect(
  ListImageScanFindingAggregations,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageScanFindingAggregations",
    operation: imagebuilder.listImageScanFindingAggregations,
    // Image Builder serves scan aggregations from Amazon Inspector, so the
    // API authorizes the dependent inspector2 action too — without it the
    // call fails with AccessDeniedException even when the imagebuilder
    // action is granted.
    actions: [
      "imagebuilder:ListImageScanFindingAggregations",
      "inspector2:ListFindingAggregations",
    ],
  }),
);
