import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterScopeHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { ListClusters } from "./ListClusters.ts";

/**
 * HTTP implementation of {@link ListClusters}.
 *
 * @layer
 * @provides Stackit.SKE.ListClusters
 */
export const ListClustersHttp = Layer.effect(
  ListClusters,
  makeClusterScopeHttpBinding({
    tag: "Stackit.SKE.ListClusters",
    access: SKE_ACCESS.listClusters,
    operation: ske.listClusters,
  }),
);
