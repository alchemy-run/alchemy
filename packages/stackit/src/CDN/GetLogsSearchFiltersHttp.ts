import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { GetLogsSearchFilters } from "./GetLogsSearchFilters.ts";

/**
 * HTTP implementation of {@link GetLogsSearchFilters}.
 *
 * @layer
 * @provides Stackit.CDN.GetLogsSearchFilters
 */
export const GetLogsSearchFiltersHttp = Layer.effect(
  GetLogsSearchFilters,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.GetLogsSearchFilters",
    access: CDN_READ_ACCESS,
    operation: cdn.getLogsSearchFilters,
  }),
);
