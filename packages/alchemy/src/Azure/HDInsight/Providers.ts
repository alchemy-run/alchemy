import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import {
  AzureMonitorIntegration,
  AzureMonitorIntegrationProvider,
} from "./AzureMonitorIntegration.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { Extension, ExtensionProvider } from "./Extension.ts";

export const resources = [
  Application,
  AzureMonitorIntegration,
  Cluster,
  Extension,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationProvider(),
    AzureMonitorIntegrationProvider(),
    ClusterProvider(),
    ExtensionProvider(),
  );
