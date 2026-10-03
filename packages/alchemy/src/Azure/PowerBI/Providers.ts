import * as Layer from "effect/Layer";
import { AutoScaleVCore, AutoScaleVCoreProvider } from "./AutoScaleVCore.ts";
import { Capacity, CapacityProvider } from "./Capacity.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import {
  PrivateLinkService,
  PrivateLinkServiceProvider,
} from "./PrivateLinkService.ts";

export const resources = [
  AutoScaleVCore,
  Capacity,
  PrivateEndpointConnection,
  PrivateLinkService,
];
export const layers = () =>
  Layer.mergeAll(
    AutoScaleVCoreProvider(),
    CapacityProvider(),
    PrivateEndpointConnectionProvider(),
    PrivateLinkServiceProvider(),
  );
