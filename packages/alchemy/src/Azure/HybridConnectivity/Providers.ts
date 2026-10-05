import * as Layer from "effect/Layer";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import {
  ServiceConfiguration,
  ServiceConfigurationProvider,
} from "./ServiceConfiguration.ts";

export const resources = [Endpoint, ServiceConfiguration];
export const layers = () =>
  Layer.mergeAll(EndpointProvider(), ServiceConfigurationProvider());
