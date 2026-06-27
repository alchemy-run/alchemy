import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeLimitsRequest extends Kinesis.DescribeLimitsInput {}

/** @binding */
export interface DescribeLimits extends Binding.Service<
  DescribeLimits,
  "AWS.Kinesis.DescribeLimits",
  () => Effect.Effect<
    (
      request?: DescribeLimitsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeLimitsOutput,
      Kinesis.DescribeLimitsError
    >
  >
> {}

export const DescribeLimits = Binding.Service<DescribeLimits>(
  "AWS.Kinesis.DescribeLimits",
);
