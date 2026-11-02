import * as edge from "@distilled.cloud/stackit/edge";
import * as Layer from "effect/Layer";
import { EDGE_ACCESS, makeInstanceScopeHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeInstanceScopeHttpBinding({
    tag: "Stackit.EdgeCloud.ListInstances",
    access: EDGE_ACCESS.listInstances,
    operation: edge.listInstances,
  }),
);
