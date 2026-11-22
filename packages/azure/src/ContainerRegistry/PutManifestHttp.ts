import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { PutManifest } from "./PutManifest.ts";

/**
 * Implementation of {@link PutManifest} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryPushRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.PutManifest
 */
export const PutManifestHttp = Layer.effect(
  PutManifest,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.PutManifest",
    operation: acr.CreateContainerRegistryManifest,
    grants: [RegistryRole.Push],
  }),
);
