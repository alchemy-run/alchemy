import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { UpdateRepositoryProperties } from "./UpdateRepositoryProperties.ts";

/**
 * Implementation of {@link UpdateRepositoryProperties} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryWriteMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.UpdateRepositoryProperties
 */
export const UpdateRepositoryPropertiesHttp = Layer.effect(
  UpdateRepositoryProperties,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.UpdateRepositoryProperties",
    operation: acr.UpdateContainerRegistryProperties,
    grants: [RegistryRole.WriteMetadata],
  }),
);
