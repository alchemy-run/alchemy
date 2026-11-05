import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:ListCisScanResultsAggregatedByTargetResource`.
 *
 * Lists scan results aggregated by a target resource.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByTargetResourceHttp)`.
 * ### CIS Scan Results
 * **Example:** CIS Results by Target Resource
 * ```typescript
 * // init
 * const listCisScanResultsAggregatedByTargetResource = yield* AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource();
 *
 * // runtime
 * const { targetResourceAggregations } = yield* listCisScanResultsAggregatedByTargetResource({ scanArn });
 * ```
 *
 * @binding
 */
export interface ListCisScanResultsAggregatedByTargetResource extends Binding.Service<
  ListCisScanResultsAggregatedByTargetResource,
  "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
  () => Effect.Effect<
    (
      request: inspector2.ListCisScanResultsAggregatedByTargetResourceRequest,
    ) => Effect.Effect<
      inspector2.ListCisScanResultsAggregatedByTargetResourceResponse,
      inspector2.ListCisScanResultsAggregatedByTargetResourceError
    >
  >
> {}
export const ListCisScanResultsAggregatedByTargetResource =
  Binding.Service<ListCisScanResultsAggregatedByTargetResource>(
    "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
  );

export const ListCisScanResultsAggregatedByTargetResourceHttp = Layer.effect(
  ListCisScanResultsAggregatedByTargetResource,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
    operation: inspector2.listCisScanResultsAggregatedByTargetResource,
    actions: ["inspector2:ListCisScanResultsAggregatedByTargetResource"],
  }),
);
