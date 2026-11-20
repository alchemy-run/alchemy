import * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeReportDefinitionHttpBinding } from "./BindingHttp.ts";
import type { ReportDefinition } from "./ReportDefinition.ts";

/**
 * Runtime binding for `cur:ListTagsForResource` — read the tags on the bound
 * {@link ReportDefinition}. The report's name is injected automatically, so
 * the runtime callable takes no arguments.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.CostAndUsageReport.ListTagsForResourceHttp)`.
 * ### Reading Report Tags
 * **Example:** List the tags on a report definition
 * ```typescript
 * // init — grants cur:ListTagsForResource on the report's ARN
 * const listReportTags =
 *   yield* AWS.CostAndUsageReport.ListTagsForResource(report);
 *
 * // runtime
 * const { Tags } = yield* listReportTags();
 * for (const tag of Tags ?? []) {
 *   yield* Effect.log(`${tag.Key}=${tag.Value}`);
 * }
 * ```
 *
 * @binding
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.CostAndUsageReport.ListTagsForResource",
  (
    report: ReportDefinition,
  ) => Effect.Effect<
    () => Effect.Effect<cur.ListTagsForResourceResponse, cur.ListTagsForResourceError>
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.CostAndUsageReport.ListTagsForResource",
);

/**
 * HTTP implementation of {@link ListTagsForResource}: grants
 * `cur:ListTagsForResource` on the bound report definition's ARN and calls
 * the us-east-1 CUR endpoint with the function's IAM credentials, injecting
 * the report's name as the `ReportName`.
 */
export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeReportDefinitionHttpBinding({
    capability: "ListTagsForResource",
    iamActions: ["cur:ListTagsForResource"],
    operation: cur.listTagsForResource,
  }),
);
