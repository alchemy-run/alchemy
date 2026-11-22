import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { ListManifests } from "./ListManifests.ts";

/**
 * Implementation of {@link ListManifests} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryReadMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.ListManifests
 */
export const ListManifestsHttp = Layer.effect(
  ListManifests,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.ListManifests",
    operation: acr.GetContainerRegistryManifests,
    grants: [RegistryRole.ReadMetadata],
  }),
);
