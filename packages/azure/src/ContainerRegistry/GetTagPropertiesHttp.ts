import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { GetTagProperties } from "./GetTagProperties.ts";

/**
 * Implementation of {@link GetTagProperties} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryReadMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.GetTagProperties
 */
export const GetTagPropertiesHttp = Layer.effect(
  GetTagProperties,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.GetTagProperties",
    operation: acr.GetContainerRegistryTagProperties,
    grants: [RegistryRole.ReadMetadata],
  }),
);
