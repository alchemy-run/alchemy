import * as edge from "@distilled.cloud/stackit/edge";
import * as Layer from "effect/Layer";
import { EDGE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.EdgeCloud.GetInstance",
    access: EDGE_ACCESS.getInstance,
    operation: edge.getInstance,
  }),
);
