import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import { ApplicationType, ApplicationTypeProvider } from "./ApplicationType.ts";
import {
  ApplicationTypeVersion,
  ApplicationTypeVersionProvider,
} from "./ApplicationTypeVersion.ts";
import { ManagedCluster, ManagedClusterProvider } from "./ManagedCluster.ts";
import { NodeType, NodeTypeProvider } from "./NodeType.ts";
import { Service, ServiceProvider } from "./Service.ts";

export const resources = [
  Application,
  ApplicationType,
  ApplicationTypeVersion,
  ManagedCluster,
  NodeType,
  Service,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationProvider(),
    ApplicationTypeProvider(),
    ApplicationTypeVersionProvider(),
    ManagedClusterProvider(),
    NodeTypeProvider(),
    ServiceProvider(),
  );
