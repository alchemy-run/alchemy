import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Layer from "effect/Layer";
import { makeRegistryHttpBinding, RegistryRole } from "./BindingHttp.ts";
import { GetBlob } from "./GetBlob.ts";

/**
 * Implementation of {@link GetBlob} over the distilled
 * `containerregistry-data` data plane. Assigns the custom
 * `AzureContainerRegistryPullRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.GetBlob
 */
export const GetBlobHttp = Layer.effect(
  GetBlob,
  makeRegistryHttpBinding({
    tag: "Azure.ContainerRegistry.GetBlob",
    operation: acr.GetContainerRegistryBlobBlob,
    grants: [RegistryRole.Pull],
  }),
);
