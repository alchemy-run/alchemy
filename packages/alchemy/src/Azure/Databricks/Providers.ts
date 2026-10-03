import * as Layer from "effect/Layer";
import { AccessConnector, AccessConnectorProvider } from "./AccessConnector.ts";
import {
  VirtualNetworkPeering,
  VirtualNetworkPeeringProvider,
} from "./VirtualNetworkPeering.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [AccessConnector, VirtualNetworkPeering, Workspace];
export const layers = () =>
  Layer.mergeAll(
    AccessConnectorProvider(),
    VirtualNetworkPeeringProvider(),
    WorkspaceProvider(),
  );
