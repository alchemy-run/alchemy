import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeContainerAppActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { StopContainerApp } from "./StopContainerApp.ts";

/**
 * Implementation of {@link StopContainerApp} over the distilled `app` ARM
 * operation `StopContainerApp`. Assigns the custom `AzureContainerAppsContainerAppStopRole` on the
 * container app.
 *
 * @layer
 * @provides Azure.ContainerApps.StopContainerApp
 */
export const StopContainerAppHttp = Layer.effect(
  StopContainerApp,
  makeContainerAppActionBinding({
    tag: "Azure.ContainerApps.StopContainerApp",
    operation: app.StopContainerApp,
    grant: ContainerAppsRole.ContainerAppStop,
  }),
);
