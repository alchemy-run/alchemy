import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeContainerAppActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { StartContainerApp } from "./StartContainerApp.ts";

/**
 * Implementation of {@link StartContainerApp} over the distilled `app` ARM
 * operation `StartContainerApp`. Assigns the custom `AzureContainerAppsContainerAppStartRole` on the
 * container app.
 *
 * @layer
 * @provides Azure.ContainerApps.StartContainerApp
 */
export const StartContainerAppHttp = Layer.effect(
  StartContainerApp,
  makeContainerAppActionBinding({
    tag: "Azure.ContainerApps.StartContainerApp",
    operation: app.StartContainerApp,
    grant: ContainerAppsRole.ContainerAppStart,
  }),
);
