import * as aci from "@distilled.cloud/azure/containerinstance";
import * as Layer from "effect/Layer";
import { makeContainerGroupActionBinding, ContainerInstanceRole } from "./BindingHttp.ts";
import { StartContainerGroup } from "./StartContainerGroup.ts";

/**
 * Implementation of {@link StartContainerGroup} over the distilled `containerinstance` ARM
 * operation `StartContainerGroup`. Assigns the custom `AzureContainerInstanceContainerGroupStartRole` on the
 * container group.
 *
 * @layer
 * @provides Azure.ContainerInstance.StartContainerGroup
 */
export const StartContainerGroupHttp = Layer.effect(
  StartContainerGroup,
  makeContainerGroupActionBinding({
    tag: "Azure.ContainerInstance.StartContainerGroup",
    operation: aci.StartContainerGroup,
    grant: ContainerInstanceRole.ContainerGroupStart,
  }),
);
