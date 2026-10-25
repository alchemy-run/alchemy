import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { GetRepositoryProperties } from "./GetRepositoryProperties.ts";

/**
 * Implementation of {@link GetRepositoryProperties} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryReadMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.GetRepositoryProperties
 */
export const GetRepositoryPropertiesHttp = Layer.effect(
  GetRepositoryProperties,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.GetRepositoryProperties",
    operation: acr.GetContainerRegistryProperties,
    grants: [RegistryRole.ReadMetadata],
  }),
);
