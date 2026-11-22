import * as Layer from "effect/Layer";
import { BatchDeployment, BatchDeploymentProvider } from "./BatchDeployment.ts";
import { BatchEndpoint, BatchEndpointProvider } from "./BatchEndpoint.ts";
import { CapabilityHost, CapabilityHostProvider } from "./CapabilityHost.ts";
import { CodeContainer, CodeContainerProvider } from "./CodeContainer.ts";
import { CodeVersion, CodeVersionProvider } from "./CodeVersion.ts";
import { ComponentContainer, ComponentContainerProvider } from "./ComponentContainer.ts";
import { ComponentVersion, ComponentVersionProvider } from "./ComponentVersion.ts";
import { Compute, ComputeProvider } from "./Compute.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { DataContainer, DataContainerProvider } from "./DataContainer.ts";
import { Datastore, DatastoreProvider } from "./Datastore.ts";
import { DataVersion, DataVersionProvider } from "./DataVersion.ts";
import { EnvironmentContainer, EnvironmentContainerProvider } from "./EnvironmentContainer.ts";
import { EnvironmentVersion, EnvironmentVersionProvider } from "./EnvironmentVersion.ts";
import { FeaturesetContainer, FeaturesetContainerProvider } from "./FeaturesetContainer.ts";
import { FeaturesetVersion, FeaturesetVersionProvider } from "./FeaturesetVersion.ts";
import {
  FeaturestoreEntityContainer,
  FeaturestoreEntityContainerProvider,
} from "./FeaturestoreEntityContainer.ts";
import {
  FeaturestoreEntityVersion,
  FeaturestoreEntityVersionProvider,
} from "./FeaturestoreEntityVersion.ts";
import {
  MarketplaceSubscription,
  MarketplaceSubscriptionProvider,
} from "./MarketplaceSubscription.ts";
import { ModelContainer, ModelContainerProvider } from "./ModelContainer.ts";
import { ModelVersion, ModelVersionProvider } from "./ModelVersion.ts";
import { OnlineDeployment, OnlineDeploymentProvider } from "./OnlineDeployment.ts";
import { OnlineEndpoint, OnlineEndpointProvider } from "./OnlineEndpoint.ts";
import { OutboundRule, OutboundRuleProvider } from "./OutboundRule.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";
import { ServerlessEndpoint, ServerlessEndpointProvider } from "./ServerlessEndpoint.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  BatchDeployment,
  BatchEndpoint,
  CapabilityHost,
  CodeContainer,
  CodeVersion,
  ComponentContainer,
  ComponentVersion,
  Compute,
  Connection,
  DataContainer,
  Datastore,
  DataVersion,
  EnvironmentContainer,
  EnvironmentVersion,
  FeaturesetContainer,
  FeaturesetVersion,
  FeaturestoreEntityContainer,
  FeaturestoreEntityVersion,
  MarketplaceSubscription,
  ModelContainer,
  ModelVersion,
  OnlineDeployment,
  OnlineEndpoint,
  OutboundRule,
  Registry,
  Schedule,
  ServerlessEndpoint,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    BatchDeploymentProvider(),
    BatchEndpointProvider(),
    CapabilityHostProvider(),
    CodeContainerProvider(),
    CodeVersionProvider(),
    ComponentContainerProvider(),
    ComponentVersionProvider(),
    ComputeProvider(),
    ConnectionProvider(),
    DataContainerProvider(),
    DatastoreProvider(),
    DataVersionProvider(),
    EnvironmentContainerProvider(),
    EnvironmentVersionProvider(),
    FeaturesetContainerProvider(),
    FeaturesetVersionProvider(),
    FeaturestoreEntityContainerProvider(),
    FeaturestoreEntityVersionProvider(),
    MarketplaceSubscriptionProvider(),
    ModelContainerProvider(),
    ModelVersionProvider(),
    OnlineDeploymentProvider(),
    OnlineEndpointProvider(),
    OutboundRuleProvider(),
    RegistryProvider(),
    ScheduleProvider(),
    ServerlessEndpointProvider(),
    WorkspaceProvider(),
  );
