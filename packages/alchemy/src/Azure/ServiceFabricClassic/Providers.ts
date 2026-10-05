import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import { ApplicationType, ApplicationTypeProvider } from "./ApplicationType.ts";
import {
  ApplicationTypeVersion,
  ApplicationTypeVersionProvider,
} from "./ApplicationTypeVersion.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { Service, ServiceProvider } from "./Service.ts";

export const resources = [
  Application,
  ApplicationType,
  ApplicationTypeVersion,
  Cluster,
  Service,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationProvider(),
    ApplicationTypeProvider(),
    ApplicationTypeVersionProvider(),
    ClusterProvider(),
    ServiceProvider(),
  );
