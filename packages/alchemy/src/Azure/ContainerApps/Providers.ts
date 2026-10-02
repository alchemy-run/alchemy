import * as Layer from "effect/Layer";
import { AuthConfig, AuthConfigProvider } from "./AuthConfig.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { ContainerApp, ContainerAppProvider } from "./ContainerApp.ts";
import { DaprComponent, DaprComponentProvider } from "./DaprComponent.ts";
import {
  EnvironmentStorage,
  EnvironmentStorageProvider,
} from "./EnvironmentStorage.ts";
import { Job, JobProvider } from "./Job.ts";
import {
  ManagedEnvironment,
  ManagedEnvironmentProvider,
} from "./ManagedEnvironment.ts";
import { SessionPool, SessionPoolProvider } from "./SessionPool.ts";

export const resources = [
  AuthConfig,
  Certificate,
  ContainerApp,
  DaprComponent,
  EnvironmentStorage,
  Job,
  ManagedEnvironment,
  SessionPool,
];
export const layers = () =>
  Layer.mergeAll(
    AuthConfigProvider(),
    CertificateProvider(),
    ContainerAppProvider(),
    DaprComponentProvider(),
    EnvironmentStorageProvider(),
    JobProvider(),
    ManagedEnvironmentProvider(),
    SessionPoolProvider(),
  );
