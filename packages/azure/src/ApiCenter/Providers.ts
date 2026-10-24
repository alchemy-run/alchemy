import * as Layer from "effect/Layer";
import { Api, ApiProvider } from "./Api.ts";
import { ApiDefinition, ApiDefinitionProvider } from "./ApiDefinition.ts";
import { ApiVersion, ApiVersionProvider } from "./ApiVersion.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { MetadataSchema, MetadataSchemaProvider } from "./MetadataSchema.ts";
import { Service, ServiceProvider } from "./Service.ts";

export const resources = [
  Api,
  ApiDefinition,
  ApiVersion,
  Deployment,
  Environment,
  MetadataSchema,
  Service,
];
export const layers = () =>
  Layer.mergeAll(
    ApiProvider(),
    ApiDefinitionProvider(),
    ApiVersionProvider(),
    DeploymentProvider(),
    EnvironmentProvider(),
    MetadataSchemaProvider(),
    ServiceProvider(),
  );
