import * as Layer from "effect/Layer";
import {
  IntegrationFabric,
  IntegrationFabricProvider,
} from "./IntegrationFabric.ts";
import {
  ManagedPrivateEndpoint,
  ManagedPrivateEndpointProvider,
} from "./ManagedPrivateEndpoint.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [IntegrationFabric, ManagedPrivateEndpoint, Workspace];
export const layers = () =>
  Layer.mergeAll(
    IntegrationFabricProvider(),
    ManagedPrivateEndpointProvider(),
    WorkspaceProvider(),
  );
