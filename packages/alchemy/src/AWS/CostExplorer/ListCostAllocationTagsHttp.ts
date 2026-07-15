import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { ListCostAllocationTags } from "./ListCostAllocationTags.ts";

export const ListCostAllocationTagsHttp = Layer.effect(
  ListCostAllocationTags,
  makeCostExplorerHttpBinding<
    ce.ListCostAllocationTagsRequest,
    ce.ListCostAllocationTagsResponse,
    ce.ListCostAllocationTagsError
  >({
    capability: "ListCostAllocationTags",
    iamActions: ["ce:ListCostAllocationTags"],
    operation: ce.listCostAllocationTags,
  }),
);
