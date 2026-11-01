import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { GetArtifact } from "./GetArtifact.ts";

/**
 * HTTP implementation of {@link GetArtifact}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.GetArtifact
 */
export const GetArtifactHttp = Layer.effect(
  GetArtifact,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.GetArtifact",
    operation: harbor.getArtifact,
  }),
);
