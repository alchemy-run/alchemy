import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { ListTags } from "./ListTags.ts";

/**
 * Implementation of {@link ListTags} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryReadMetadataRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.ListTags
 */
export const ListTagsHttp = Layer.effect(
  ListTags,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.ListTags",
    operation: acr.GetContainerRegistryTags,
    grants: [RegistryRole.ReadMetadata],
  }),
);
