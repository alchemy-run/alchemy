import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { DeleteTag } from "./DeleteTag.ts";

/**
 * Implementation of {@link DeleteTag} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryDeleteRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.DeleteTag
 */
export const DeleteTagHttp = Layer.effect(
  DeleteTag,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.DeleteTag",
    operation: acr.DeleteContainerRegistryTag,
    grants: [RegistryRole.Delete],
  }),
);
