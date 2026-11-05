import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `securityhub:GetInsights`.
 *
 * Lists and describes Security Hub insights (saved, grouped finding queries).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetInsightsHttp)`.
 * ### Working with Insights
 * **Example:** List Custom Insights
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInsights = yield* AWS.SecurityHub.GetInsights();
 *
 * // runtime
 * const { Insights } = yield* getInsights();
 * ```
 *
 * @binding
 */
export interface GetInsights extends Binding.Service<
  GetInsights,
  "AWS.SecurityHub.GetInsights",
  () => Effect.Effect<
    (
      request?: securityhub.GetInsightsRequest,
    ) => Effect.Effect<securityhub.GetInsightsResponse, securityhub.GetInsightsError>
  >
> {}
export const GetInsights = Binding.Service<GetInsights>("AWS.SecurityHub.GetInsights");

export const GetInsightsHttp = Layer.effect(
  GetInsights,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetInsights",
    operation: securityhub.getInsights,
    actions: ["securityhub:GetInsights"],
  }),
);
