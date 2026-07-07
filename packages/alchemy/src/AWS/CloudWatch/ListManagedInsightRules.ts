import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListManagedInsightRulesRequest
  extends cloudwatch.ListManagedInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListManagedInsightRules`.
 * @binding
 */
export interface ListManagedInsightRules extends Binding.Service<
  ListManagedInsightRules,
  "AWS.CloudWatch.ListManagedInsightRules",
  () => Effect.Effect<
    (
      request?: ListManagedInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListManagedInsightRulesOutput,
      cloudwatch.ListManagedInsightRulesError
    >
  >
> {}

export const ListManagedInsightRules = Binding.Service<ListManagedInsightRules>(
  "AWS.CloudWatch.ListManagedInsightRules",
);
