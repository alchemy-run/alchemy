import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { GetManifest } from "./GetManifest.ts";

/**
 * Implementation of {@link GetManifest} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryPullRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.GetManifest
 */
export const GetManifestHttp = Layer.effect(
  GetManifest,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.GetManifest",
    operation: acr.GetContainerRegistryManifest,
    grants: [RegistryRole.Pull],
  }),
);
