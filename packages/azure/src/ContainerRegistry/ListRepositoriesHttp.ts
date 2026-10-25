import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { ListRepositories } from "./ListRepositories.ts";

/**
 * Implementation of {@link ListRepositories} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryListCatalogRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.ListRepositories
 */
export const ListRepositoriesHttp = Layer.effect(
  ListRepositories,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.ListRepositories",
    operation: acr.GetContainerRegistryRepositories,
    grants: [RegistryRole.ListCatalog],
  }),
);
