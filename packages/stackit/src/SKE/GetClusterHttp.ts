import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides Stackit.SKE.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.GetCluster",
    access: SKE_ACCESS.getCluster,
    operation: ske.getCluster,
  }),
);
