import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostCategoryHttpBinding } from "./BindingHttp.ts";
import { ListCostCategoryResourceAssociations } from "./ListCostCategoryResourceAssociations.ts";

export const ListCostCategoryResourceAssociationsHttp = Layer.effect(
  ListCostCategoryResourceAssociations,
  makeCostCategoryHttpBinding<
    ce.ListCostCategoryResourceAssociationsRequest,
    ce.ListCostCategoryResourceAssociationsResponse,
    ce.ListCostCategoryResourceAssociationsError
  >({
    capability: "ListCostCategoryResourceAssociations",
    iamActions: ["ce:ListCostCategoryResourceAssociations"],
    operation: ce.listCostCategoryResourceAssociations,
  }),
);
