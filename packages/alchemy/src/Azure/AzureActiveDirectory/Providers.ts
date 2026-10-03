import * as Layer from "effect/Layer";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import {
  PrivateLinkPolicy,
  PrivateLinkPolicyProvider,
} from "./PrivateLinkPolicy.ts";

export const resources = [PrivateLinkPolicy, PrivateEndpointConnection];
export const layers = () =>
  Layer.mergeAll(
    PrivateLinkPolicyProvider(),
    PrivateEndpointConnectionProvider(),
  );
