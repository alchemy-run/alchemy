import * as edge from "@distilled.cloud/stackit/edge";
import * as Layer from "effect/Layer";
import { makeDiscoveryHttpBinding } from "./BindingHttp.ts";
import { ListPlans } from "./ListPlans.ts";

/**
 * HTTP implementation of {@link ListPlans}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.ListPlans
 */
export const ListPlansHttp = Layer.effect(
  ListPlans,
  makeDiscoveryHttpBinding({
    tag: "Stackit.EdgeCloud.ListPlans",
    operation: edge.listPlansProject,
  }),
);
