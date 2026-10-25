import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { DeleteRepository } from "./DeleteRepository.ts";

/**
 * Implementation of {@link DeleteRepository} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryDeleteRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.DeleteRepository
 */
export const DeleteRepositoryHttp = Layer.effect(
  DeleteRepository,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.DeleteRepository",
    operation: acr.DeleteContainerRegistryRepository,
    grants: [RegistryRole.Delete],
  }),
);
