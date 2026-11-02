import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { GetDistribution } from "./GetDistribution.ts";

/**
 * HTTP implementation of {@link GetDistribution}.
 *
 * @layer
 * @provides Stackit.CDN.GetDistribution
 */
export const GetDistributionHttp = Layer.effect(
  GetDistribution,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.GetDistribution",
    access: CDN_READ_ACCESS,
    operation: cdn.getDistribution,
  }),
);
