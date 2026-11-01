import * as edge from "@distilled.cloud/stackit/edge";
import * as Layer from "effect/Layer";
import { makeDiscoveryHttpBinding } from "./BindingHttp.ts";
import { ListCompatibleKubernetesReleases } from "./ListCompatibleKubernetesReleases.ts";

/**
 * HTTP implementation of {@link ListCompatibleKubernetesReleases}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.ListCompatibleKubernetesReleases
 */
export const ListCompatibleKubernetesReleasesHttp = Layer.effect(
  ListCompatibleKubernetesReleases,
  makeDiscoveryHttpBinding({
    tag: "Stackit.EdgeCloud.ListCompatibleKubernetesReleases",
    operation: edge.listCompatibleKubernetesReleases,
  }),
);
