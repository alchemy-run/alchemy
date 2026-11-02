import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { DeleteArtifact } from "./DeleteArtifact.ts";

/**
 * HTTP implementation of {@link DeleteArtifact}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.DeleteArtifact
 */
export const DeleteArtifactHttp = Layer.effect(
  DeleteArtifact,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.DeleteArtifact",
    operation: harbor.deleteArtifact,
  }),
);
