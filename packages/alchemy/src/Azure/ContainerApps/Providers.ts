import * as Layer from "effect/Layer";
import { Agent, AgentProvider } from "./Agent.ts";
import { AgentConnector, AgentConnectorProvider } from "./AgentConnector.ts";
import { AgentSpace, AgentSpaceProvider } from "./AgentSpace.ts";
import {
  AgentSpaceConnector,
  AgentSpaceConnectorProvider,
} from "./AgentSpaceConnector.ts";
import { AuthConfig, AuthConfigProvider } from "./AuthConfig.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import {
  ConnectedEnvironment,
  ConnectedEnvironmentProvider,
} from "./ConnectedEnvironment.ts";
import {
  ConnectedEnvironmentCertificate,
  ConnectedEnvironmentCertificateProvider,
} from "./ConnectedEnvironmentCertificate.ts";
import {
  ConnectedEnvironmentDaprComponent,
  ConnectedEnvironmentDaprComponentProvider,
} from "./ConnectedEnvironmentDaprComponent.ts";
import {
  ConnectedEnvironmentStorage,
  ConnectedEnvironmentStorageProvider,
} from "./ConnectedEnvironmentStorage.ts";
import { ContainerApp, ContainerAppProvider } from "./ContainerApp.ts";
import { DaprComponent, DaprComponentProvider } from "./DaprComponent.ts";
import {
  DaprComponentResiliencyPolicy,
  DaprComponentResiliencyPolicyProvider,
} from "./DaprComponentResiliencyPolicy.ts";
import { DotNetComponent, DotNetComponentProvider } from "./DotNetComponent.ts";
import {
  EnvironmentStorage,
  EnvironmentStorageProvider,
} from "./EnvironmentStorage.ts";
import { HttpRouteConfig, HttpRouteConfigProvider } from "./HttpRouteConfig.ts";
import { JavaComponent, JavaComponentProvider } from "./JavaComponent.ts";
import { Job, JobProvider } from "./Job.ts";
import { LogicApp, LogicAppProvider } from "./LogicApp.ts";
import {
  MaintenanceConfiguration,
  MaintenanceConfigurationProvider,
} from "./MaintenanceConfiguration.ts";
import {
  ManagedCertificate,
  ManagedCertificateProvider,
} from "./ManagedCertificate.ts";
import {
  ManagedEnvironment,
  ManagedEnvironmentProvider,
} from "./ManagedEnvironment.ts";
import { SandboxGroup, SandboxGroupProvider } from "./SandboxGroup.ts";
import {
  SandboxVnetConnection,
  SandboxVnetConnectionProvider,
} from "./SandboxVnetConnection.ts";
import { SessionPool, SessionPoolProvider } from "./SessionPool.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";

export const resources = [
  Agent,
  AgentConnector,
  AgentSpace,
  AgentSpaceConnector,
  AuthConfig,
  Certificate,
  ConnectedEnvironment,
  ConnectedEnvironmentCertificate,
  ConnectedEnvironmentDaprComponent,
  ConnectedEnvironmentStorage,
  ContainerApp,
  DaprComponent,
  DaprComponentResiliencyPolicy,
  DotNetComponent,
  EnvironmentStorage,
  HttpRouteConfig,
  JavaComponent,
  Job,
  LogicApp,
  MaintenanceConfiguration,
  ManagedCertificate,
  ManagedEnvironment,
  SandboxGroup,
  SandboxVnetConnection,
  SessionPool,
  SourceControl,
];
export const layers = () =>
  Layer.mergeAll(
    AgentProvider(),
    AgentConnectorProvider(),
    AgentSpaceProvider(),
    AgentSpaceConnectorProvider(),
    AuthConfigProvider(),
    CertificateProvider(),
    ConnectedEnvironmentProvider(),
    ConnectedEnvironmentCertificateProvider(),
    ConnectedEnvironmentDaprComponentProvider(),
    ConnectedEnvironmentStorageProvider(),
    ContainerAppProvider(),
    DaprComponentProvider(),
    DaprComponentResiliencyPolicyProvider(),
    DotNetComponentProvider(),
    EnvironmentStorageProvider(),
    HttpRouteConfigProvider(),
    JavaComponentProvider(),
    JobProvider(),
    LogicAppProvider(),
    MaintenanceConfigurationProvider(),
    ManagedCertificateProvider(),
    ManagedEnvironmentProvider(),
    SandboxGroupProvider(),
    SandboxVnetConnectionProvider(),
    SessionPoolProvider(),
    SourceControlProvider(),
  );
