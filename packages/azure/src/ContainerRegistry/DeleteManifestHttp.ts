import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { DeleteManifest } from "./DeleteManifest.ts";

/**
 * Implementation of {@link DeleteManifest} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryDeleteRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.DeleteManifest
 */
export const DeleteManifestHttp = Layer.effect(
  DeleteManifest,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.DeleteManifest",
    operation: acr.DeleteContainerRegistryManifest,
    grants: [RegistryRole.Delete],
  }),
);
