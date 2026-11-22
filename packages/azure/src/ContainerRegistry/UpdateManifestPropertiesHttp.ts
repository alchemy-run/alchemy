import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { UpdateManifestProperties } from "./UpdateManifestProperties.ts";

/**
 * Implementation of {@link UpdateManifestProperties} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryWriteMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.UpdateManifestProperties
 */
export const UpdateManifestPropertiesHttp = Layer.effect(
  UpdateManifestProperties,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.UpdateManifestProperties",
    operation: acr.UpdateContainerRegistryManifestProperties,
    grants: [RegistryRole.WriteMetadata],
  }),
);
