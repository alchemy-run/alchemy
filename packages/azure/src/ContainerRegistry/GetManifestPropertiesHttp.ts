import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { GetManifestProperties } from "./GetManifestProperties.ts";

/**
 * Implementation of {@link GetManifestProperties} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryReadMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.GetManifestProperties
 */
export const GetManifestPropertiesHttp = Layer.effect(
  GetManifestProperties,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.GetManifestProperties",
    operation: acr.GetContainerRegistryManifestProperties,
    grants: [RegistryRole.ReadMetadata],
  }),
);
