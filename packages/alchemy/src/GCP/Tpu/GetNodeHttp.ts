import * as tpu from "@distilled.cloud/gcp/tpu_v2";
import * as Layer from "effect/Layer";
import { makeTpuNodeHttpBinding } from "./BindingHttp.ts";
import { GetNode } from "./GetNode.ts";

/**
 * HTTP implementation of {@link GetNode}.
 *
 * @layer
 * @provides GCP.Tpu.GetNode
 */
export const GetNodeHttp = Layer.effect(
  GetNode,
  makeTpuNodeHttpBinding({
    tag: "GCP.Tpu.GetNode",
    operation: tpu.getProjectsLocationsNodes,
  }),
);
