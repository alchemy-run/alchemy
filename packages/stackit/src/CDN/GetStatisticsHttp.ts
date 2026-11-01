import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { GetStatistics } from "./GetStatistics.ts";

/**
 * HTTP implementation of {@link GetStatistics}.
 *
 * @layer
 * @provides Stackit.CDN.GetStatistics
 */
export const GetStatisticsHttp = Layer.effect(
  GetStatistics,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.GetStatistics",
    access: CDN_READ_ACCESS,
    operation: cdn.getStatistics,
  }),
);
