import * as aci from "@distilled.cloud/azure/containerinstance";
import * as Layer from "effect/Layer";
import { makeContainerGroupActionBinding, ContainerInstanceRole } from "./BindingHttp.ts";
import { RestartContainerGroup } from "./RestartContainerGroup.ts";

/**
 * Implementation of {@link RestartContainerGroup} over the distilled `containerinstance` ARM
 * operation `RestartContainerGroup`. Assigns the custom `AzureContainerInstanceContainerGroupRestartRole` on the
 * container group.
 *
 * @layer
 * @provides Azure.ContainerInstance.RestartContainerGroup
 */
export const RestartContainerGroupHttp = Layer.effect(
  RestartContainerGroup,
  makeContainerGroupActionBinding({
    tag: "Azure.ContainerInstance.RestartContainerGroup",
    operation: aci.RestartContainerGroup,
    grant: ContainerInstanceRole.ContainerGroupRestart,
  }),
);
