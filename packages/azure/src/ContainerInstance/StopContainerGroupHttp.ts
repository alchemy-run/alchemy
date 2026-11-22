import * as aci from "@distilled.cloud/azure/containerinstance";
import * as Layer from "effect/Layer";
import { makeContainerGroupActionBinding, ContainerInstanceRole } from "./BindingHttp.ts";
import { StopContainerGroup } from "./StopContainerGroup.ts";

/**
 * Implementation of {@link StopContainerGroup} over the distilled `containerinstance` ARM
 * operation `StopContainerGroup`. Assigns the custom `AzureContainerInstanceContainerGroupStopRole` on the
 * container group.
 *
 * @layer
 * @provides Azure.ContainerInstance.StopContainerGroup
 */
export const StopContainerGroupHttp = Layer.effect(
  StopContainerGroup,
  makeContainerGroupActionBinding({
    tag: "Azure.ContainerInstance.StopContainerGroup",
    operation: aci.StopContainerGroup,
    grant: ContainerInstanceRole.ContainerGroupStop,
  }),
);
