import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeContainerAppActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { RestartContainerAppRevision } from "./RestartContainerAppRevision.ts";

/**
 * Implementation of {@link RestartContainerAppRevision} over the distilled `app` ARM
 * operation `RestartContainerAppsRevisionRevision`. Assigns the custom `AzureContainerAppsRevisionRestartRole` on the
 * container app.
 *
 * @layer
 * @provides Azure.ContainerApps.RestartContainerAppRevision
 */
export const RestartContainerAppRevisionHttp = Layer.effect(
  RestartContainerAppRevision,
  makeContainerAppActionBinding({
    tag: "Azure.ContainerApps.RestartContainerAppRevision",
    operation: app.RestartContainerAppsRevisionRevision,
    grant: ContainerAppsRole.RevisionRestart,
  }),
);
