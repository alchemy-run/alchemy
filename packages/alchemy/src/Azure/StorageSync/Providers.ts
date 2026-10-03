import * as Layer from "effect/Layer";
import { CloudEndpoint, CloudEndpointProvider } from "./CloudEndpoint.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { ServerEndpoint, ServerEndpointProvider } from "./ServerEndpoint.ts";
import {
  StorageSyncService,
  StorageSyncServiceProvider,
} from "./StorageSyncService.ts";
import { SyncGroup, SyncGroupProvider } from "./SyncGroup.ts";

export const resources = [
  CloudEndpoint,
  PrivateEndpointConnection,
  ServerEndpoint,
  StorageSyncService,
  SyncGroup,
];
export const layers = () =>
  Layer.mergeAll(
    CloudEndpointProvider(),
    PrivateEndpointConnectionProvider(),
    ServerEndpointProvider(),
    StorageSyncServiceProvider(),
    SyncGroupProvider(),
  );
