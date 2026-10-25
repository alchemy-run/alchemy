import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { DeleteBlob } from "./DeleteBlob.ts";

/**
 * Implementation of {@link DeleteBlob} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryDeleteRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.DeleteBlob
 */
export const DeleteBlobHttp = Layer.effect(
  DeleteBlob,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.DeleteBlob",
    operation: acr.DeleteContainerRegistryBlobBlob,
    grants: [RegistryRole.Delete],
  }),
);
