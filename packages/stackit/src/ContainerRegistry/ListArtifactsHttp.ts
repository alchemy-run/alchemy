import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { ListArtifacts } from "./ListArtifacts.ts";

/**
 * HTTP implementation of {@link ListArtifacts}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ListArtifacts
 */
export const ListArtifactsHttp = Layer.effect(
  ListArtifacts,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.ListArtifacts",
    operation: harbor.listArtifacts,
  }),
);
