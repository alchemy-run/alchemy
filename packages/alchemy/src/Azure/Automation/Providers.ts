import * as Layer from "effect/Layer";
import {
  AutomationAccount,
  AutomationAccountProvider,
} from "./AutomationAccount.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { ConnectionType, ConnectionTypeProvider } from "./ConnectionType.ts";
import { Credential, CredentialProvider } from "./Credential.ts";
import {
  DscConfiguration,
  DscConfigurationProvider,
} from "./DscConfiguration.ts";
import {
  DscNodeConfiguration,
  DscNodeConfigurationProvider,
} from "./DscNodeConfiguration.ts";
import {
  HybridRunbookWorker,
  HybridRunbookWorkerProvider,
} from "./HybridRunbookWorker.ts";
import {
  HybridRunbookWorkerGroup,
  HybridRunbookWorkerGroupProvider,
} from "./HybridRunbookWorkerGroup.ts";
import { JobSchedule, JobScheduleProvider } from "./JobSchedule.ts";
import { Module, ModuleProvider } from "./Module.ts";
import { Python3Package, Python3PackageProvider } from "./Python3Package.ts";
import { Runbook, RunbookProvider } from "./Runbook.ts";
import {
  RuntimeEnvironment,
  RuntimeEnvironmentProvider,
} from "./RuntimeEnvironment.ts";
import {
  RuntimeEnvironmentPackage,
  RuntimeEnvironmentPackageProvider,
} from "./RuntimeEnvironmentPackage.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Watcher, WatcherProvider } from "./Watcher.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export const resources = [
  AutomationAccount,
  Certificate,
  Connection,
  ConnectionType,
  Credential,
  DscConfiguration,
  DscNodeConfiguration,
  HybridRunbookWorker,
  HybridRunbookWorkerGroup,
  JobSchedule,
  Module,
  Python3Package,
  Runbook,
  RuntimeEnvironment,
  RuntimeEnvironmentPackage,
  Schedule,
  SourceControl,
  Variable,
  Watcher,
  Webhook,
];
export const layers = () =>
  Layer.mergeAll(
    AutomationAccountProvider(),
    CertificateProvider(),
    ConnectionProvider(),
    ConnectionTypeProvider(),
    CredentialProvider(),
    DscConfigurationProvider(),
    DscNodeConfigurationProvider(),
    HybridRunbookWorkerProvider(),
    HybridRunbookWorkerGroupProvider(),
    JobScheduleProvider(),
    ModuleProvider(),
    Python3PackageProvider(),
    RunbookProvider(),
    RuntimeEnvironmentProvider(),
    RuntimeEnvironmentPackageProvider(),
    ScheduleProvider(),
    SourceControlProvider(),
    VariableProvider(),
    WatcherProvider(),
    WebhookProvider(),
  );
