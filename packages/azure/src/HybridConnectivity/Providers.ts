import * as Layer from "effect/Layer";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { PublicCloudConnector, PublicCloudConnectorProvider } from "./PublicCloudConnector.ts";
import { ServiceConfiguration, ServiceConfigurationProvider } from "./ServiceConfiguration.ts";
import { SolutionConfiguration, SolutionConfigurationProvider } from "./SolutionConfiguration.ts";

export const resources = [
  Endpoint,
  PublicCloudConnector,
  ServiceConfiguration,
  SolutionConfiguration,
];
export const layers = () =>
  Layer.mergeAll(
    EndpointProvider(),
    PublicCloudConnectorProvider(),
    ServiceConfigurationProvider(),
    SolutionConfigurationProvider(),
  );
