import * as Layer from "effect/Layer";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { Provider, ProviderProvider } from "./Provider.ts";

export const resources = [PrivateEndpointConnection, Provider];
export const layers = () =>
  Layer.mergeAll(PrivateEndpointConnectionProvider(), ProviderProvider());
