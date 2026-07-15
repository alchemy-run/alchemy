import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetApproximateUsageRecords } from "./GetApproximateUsageRecords.ts";

export const GetApproximateUsageRecordsHttp = Layer.effect(
  GetApproximateUsageRecords,
  makeCostExplorerHttpBinding<
    ce.GetApproximateUsageRecordsRequest,
    ce.GetApproximateUsageRecordsResponse,
    ce.GetApproximateUsageRecordsError
  >({
    capability: "GetApproximateUsageRecords",
    iamActions: ["ce:GetApproximateUsageRecords"],
    operation: ce.getApproximateUsageRecords,
  }),
);
