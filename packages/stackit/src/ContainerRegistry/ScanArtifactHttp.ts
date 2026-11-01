import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { ScanArtifact } from "./ScanArtifact.ts";

/**
 * HTTP implementation of {@link ScanArtifact}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ScanArtifact
 */
export const ScanArtifactHttp = Layer.effect(
  ScanArtifact,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.ScanArtifact",
    operation: harbor.scanArtifact,
  }),
);
