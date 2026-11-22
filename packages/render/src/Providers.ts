import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { RenderAuth } from "./AuthProvider.ts";
import { BackgroundWorker, BackgroundWorkerProvider } from "./BackgroundWorker.ts";
import { Blueprint, BlueprintProvider } from "./Blueprint.ts";
import { ConnectPostgresHttp } from "./ConnectPostgresHttp.ts";
import { ConnectServiceHttp } from "./ConnectServiceHttp.ts";
import * as Credentials from "./Credentials.ts";
import { CronJob, CronJobProvider } from "./CronJob.ts";
import { DedicatedIp, DedicatedIpProvider } from "./DedicatedIp.ts";
import { EnvGroup, EnvGroupProvider } from "./EnvGroup.ts";
import { EnvGroupLink, EnvGroupLinkProvider } from "./EnvGroupLink.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { KeyValue, KeyValueProvider } from "./KeyValue.ts";
import { LogStream, LogStreamProvider } from "./LogStream.ts";
import { MetricsStream, MetricsStreamProvider } from "./MetricsStream.ts";
import { NotificationSetting, NotificationSettingProvider } from "./NotificationSetting.ts";
import { Postgres, PostgresProvider } from "./Postgres.ts";
import { PrivateService, PrivateServiceProvider } from "./PrivateService.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ReadKeyValueHttp } from "./ReadKeyValueHttp.ts";
import { ReadWriteKeyValueHttp } from "./ReadWriteKeyValueHttp.ts";
import { Redis, RedisProvider } from "./Redis.ts";
import { RegistryCredential, RegistryCredentialProvider } from "./RegistryCredential.ts";
import { RunWorkflowTaskHttp } from "./RunWorkflowTaskHttp.ts";
import { ServicePreview, ServicePreviewProvider } from "./ServicePreview.ts";
import { StaticSite, StaticSiteProvider } from "./StaticSite.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";
import { WebService, WebServiceProvider } from "./WebService.ts";
import { Workflow, WorkflowProvider } from "./Workflow.ts";
import { WriteKeyValueHttp } from "./WriteKeyValueHttp.ts";

export {
  DEFAULT_API_BASE_URL,
  RenderCredentials,
  RenderPollConfig,
  fromAuthProvider,
  fromConfig,
  type PollConfig,
  type RenderClientConfig,
} from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Render") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Render resource providers, credentials, HTTP client, and AuthProvider.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      BackgroundWorker,
      Blueprint,
      CronJob,
      DedicatedIp,
      EnvGroup,
      EnvGroupLink,
      Environment,
      KeyValue,
      LogStream,
      MetricsStream,
      NotificationSetting,
      Postgres,
      PrivateService,
      Project,
      Redis,
      RegistryCredential,
      ServicePreview,
      StaticSite,
      WebService,
      Webhook,
      Workflow,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BackgroundWorkerProvider(),
        BlueprintProvider(),
        CronJobProvider(),
        DedicatedIpProvider(),
        EnvGroupProvider(),
        EnvGroupLinkProvider(),
        EnvironmentProvider(),
        KeyValueProvider(),
        LogStreamProvider(),
        MetricsStreamProvider(),
        NotificationSettingProvider(),
        PostgresProvider(),
        PrivateServiceProvider(),
        ProjectProvider(),
        RedisProvider(),
        RegistryCredentialProvider(),
        ServicePreviewProvider(),
        StaticSiteProvider(),
        WebServiceProvider(),
        WebhookProvider(),
        WorkflowProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        ConnectPostgresHttp,
        ConnectServiceHttp,
        RunWorkflowTaskHttp,
        ReadKeyValueHttp,
        WriteKeyValueHttp,
        ReadWriteKeyValueHttp,
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RenderAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
