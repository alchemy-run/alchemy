import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { UpdateTagAttributes } from "./UpdateTagAttributes.ts";

/**
 * Implementation of {@link UpdateTagAttributes} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryWriteMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.UpdateTagAttributes
 */
export const UpdateTagAttributesHttp = Layer.effect(
  UpdateTagAttributes,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.UpdateTagAttributes",
    operation: acr.UpdateContainerRegistryTagAttributes,
    grants: [RegistryRole.WriteMetadata],
  }),
);
