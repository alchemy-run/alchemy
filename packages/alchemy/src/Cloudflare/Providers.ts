import { Retry } from "@distilled.cloud/cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import { Command } from "../Build/Command.ts";
import { DevServer, DevServerProvider } from "../Build/DevServer.ts";
import * as Build from "../Build/index.ts";
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as AccessApp from "./Access/Application.ts";
import * as Access from "./Access.ts";
import * as AccessGroup from "./Access/Group.ts";
import * as AccessOrg from "./Access/Organization.ts";
import * as AccessPol from "./Access/Policy.ts";
import * as AccessSvcToken from "./Access/ServiceToken.ts";
import * as AiGateway from "./AiGateway/index.ts";
import * as AiSearch from "./AiSearch/index.ts";
import * as Alerting from "./Alerting/index.ts";
import * as AnalyticsEngine from "./AnalyticsEngine/index.ts";
import * as ApiToken from "./ApiToken/index.ts";
import * as Artifacts from "./Artifacts/index.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as BotManagement from "./BotManagement/index.ts";
import * as Browser from "./Browser/index.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Containers from "./Container/index.ts";
import * as Credentials from "./Credentials.ts";
import * as CustomHostnames from "./CustomHostname/index.ts";
import * as D1 from "./D1/index.ts";
import * as Devices from "./Devices/index.ts";
import * as Dns from "./Dns/index.ts";
import * as Email from "./Email/index.ts";
import * as Firewall from "./Firewall/index.ts";
import * as GatewayRule from "./Gateway/Rule.ts";
import * as Healthcheck from "./Healthcheck/index.ts";
import * as Hyperdrive from "./Hyperdrive/index.ts";
import * as Images from "./Images/index.ts";
import * as KV from "./KV/index.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import * as Logpush from "./Logpush/index.ts";
import * as MtlsCertificate from "./MtlsCertificate/index.ts";
import * as Pages from "./Pages/index.ts";
import * as Pipelines from "./Pipelines/index.ts";
import * as Queue from "./Queue/index.ts";
import * as R2 from "./R2/index.ts";
import * as RateLimit from "./RateLimit/index.ts";
import * as Rules from "./Rules/index.ts";
import * as Ruleset from "./Ruleset/index.ts";
import * as SecretsStore from "./SecretsStore/index.ts";
import * as Snippets from "./Snippets/index.ts";
import * as Tunnel from "./Tunnel/index.ts";
import * as Turnstile from "./Turnstile/index.ts";
import * as Vectorize from "./Vectorize/index.ts";
import * as VpcService from "./VpcService/index.ts";
import * as Workers from "./Workers/index.ts";
import * as Workflows from "./Workers/Workflow.ts";
import * as Zaraz from "./Zaraz/index.ts";
import * as Zone from "./Zone/index.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Cloudflare",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      AccessApp.AccessApplication,
      AccessGroup.AccessGroup,
      AccessOrg.AccessOrganization,
      AccessPol.AccessPolicy,
      AccessSvcToken.AccessServiceToken,
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      AiGateway.AiGateway,
      AiGateway.AiGatewaySpendingLimit,
      AiGateway.AiGatewayBindingPolicy,
      AiSearch.AiSearchInstance,
      Alerting.NotificationPolicy,
      Alerting.NotificationWebhook,
      AnalyticsEngine.AnalyticsEngineDatasetBindingPolicy,
      Artifacts.ArtifactsBindingPolicy,
      BotManagement.BotManagement,
      Browser.BrowserBindingPolicy,
      Command,
      Containers.Container,
      D1.D1ConnectionPolicy,
      CustomHostnames.CustomHostname,
      CustomHostnames.FallbackOrigin,
      D1.D1Database,
      DevServer,
      Devices.DeviceDefaultProfile,
      Dns.DnsReadPolicy,
      Dns.DnsReadWritePolicy,
      Dns.DnsRecord,
      Dns.DnsWritePolicy,
      Email.EmailAddress,
      Email.EmailRouting,
      Email.EmailRule,
      Email.SendEmailBindingPolicy,
      Firewall.FirewallAccessRule,
      GatewayRule.GatewayRule,
      Healthcheck.Healthcheck,
      Hyperdrive.Hyperdrive,
      Hyperdrive.HyperdriveBindingPolicy,
      Images.ImagesBindingPolicy,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      Logpush.LogpushJob,
      MtlsCertificate.MtlsCertificate,
      Pages.PagesDomain,
      Pages.PagesProject,
      Pipelines.Pipeline,
      Pipelines.PipelineSink,
      Pipelines.PipelineStream,
      Queue.Queue,
      Queue.QueueBindingPolicy,
      Queue.QueueConsumer,
      Queue.QueueEventSourcePolicy,
      R2.R2Bucket,
      R2.R2BucketBindingPolicy,
      RateLimit.RateLimitBindingPolicy,
      Rules.RulesList,
      Ruleset.Ruleset,
      SecretsStore.SecretBindingPolicy,
      SecretsStore.SecretsStore,
      SecretsStore.Secret,
      Snippets.Snippet,
      Snippets.SnippetRules,
      Tunnel.Tunnel,
      Tunnel.TunnelConfiguration,
      Tunnel.TunnelReadPolicy,
      Tunnel.TunnelReadWritePolicy,
      Tunnel.TunnelRoute,
      Tunnel.TunnelWritePolicy,
      Turnstile.TurnstileWidget,
      Vectorize.VectorizeIndexBindingPolicy,
      Vectorize.VectorizeIndex,
      Vectorize.VectorizeMetadataIndex,
      VpcService.VpcService,
      KeyPair,
      Random,
      Workers.BindWorkerPolicy,
      Workers.CronEventSourcePolicy,
      Workers.FetchPolicy,
      Workers.VersionMetadataBindingPolicy,
      Workers.Worker,
      Workers.WorkerRoute,
      Workflows.WorkflowResource,
      Zaraz.ZarazConfig,
      Zone.Zone,
      Zone.ZoneSetting,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessApp.AccessApplicationProvider(),
        AccessGroup.AccessGroupProvider(),
        AccessOrg.AccessOrganizationProvider(),
        AccessPol.AccessPolicyProvider(),
        AccessSvcToken.AccessServiceTokenProvider(),
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        AiGateway.AiGatewayProvider(),
        AiGateway.AiGatewaySpendingLimitProvider(),
        AiGateway.AiGatewayBindingPolicyLive,
        AiSearch.AiSearchInstanceProvider(),
        Alerting.NotificationPolicyProvider(),
        Alerting.NotificationWebhookProvider(),
        AnalyticsEngine.AnalyticsEngineDatasetBindingPolicyLive,
        Artifacts.ArtifactsBindingPolicyLive,
        BotManagement.BotManagementProvider(),
        Browser.BrowserBindingPolicyLive,
        Containers.ContainerProvider(),
        D1.D1ConnectionPolicyLive,
        CustomHostnames.CustomHostnameProvider(),
        CustomHostnames.FallbackOriginProvider(),
        D1.DatabaseProvider(),
        DevServerProvider(),
        Devices.DeviceDefaultProfileProvider(),
        Dns.DnsReadPolicyLive,
        Dns.DnsReadWritePolicyLive,
        Dns.DnsRecordProvider(),
        Dns.DnsWritePolicyLive,
        Email.EmailAddressProvider(),
        Email.EmailRoutingProvider(),
        Email.EmailRuleProvider(),
        Email.SendEmailBindingPolicyLive,
        Firewall.FirewallAccessRuleProvider(),
        GatewayRule.GatewayRuleProvider(),
        Healthcheck.HealthcheckProvider(),
        Hyperdrive.HyperdriveBindingPolicyLive,
        Hyperdrive.HyperdriveProvider(),
        Images.ImagesBindingPolicyLive,
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        Logpush.LogpushJobProvider(),
        MtlsCertificate.MtlsCertificateProvider(),
        Pages.PagesDomainProvider(),
        Pages.PagesProjectProvider(),
        Pipelines.PipelineProvider(),
        Pipelines.PipelineSinkProvider(),
        Pipelines.PipelineStreamProvider(),
        Queue.QueueBindingPolicyLive,
        Queue.QueueEventSourcePolicyLive,
        Queue.QueueProvider(),
        Queue.QueueConsumerProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketProvider(),
        RateLimit.RateLimitBindingPolicyLive,
        Rules.RulesListProvider(),
        Ruleset.RulesetProvider(),
        SecretsStore.SecretBindingPolicyLive,
        SecretsStore.SecretsStoreProvider(),
        SecretsStore.StoreSecretProvider(),
        Snippets.SnippetProvider(),
        Snippets.SnippetRulesProvider(),
        Tunnel.TunnelProvider(),
        Tunnel.TunnelConfigurationProvider(),
        Tunnel.TunnelReadPolicyLive,
        Tunnel.TunnelReadWritePolicyLive,
        Tunnel.TunnelRouteProvider(),
        Tunnel.TunnelWritePolicyLive,
        Turnstile.TurnstileWidgetProvider(),
        Vectorize.VectorizeIndexBindingPolicyLive,
        Vectorize.VectorizeIndexProvider(),
        Vectorize.VectorizeMetadataIndexProvider(),
        VpcService.VpcServiceProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.CronEventSourcePolicyLive,
        Workers.FetchPolicyLive,
        Workers.VersionMetadataBindingPolicyLive,
        Workers.WorkerProvider(),
        Workers.WorkerRouteProvider(),
        Workflows.WorkflowProvider(),
        Zaraz.ZarazConfigProvider(),
        Zone.ZoneProvider(),
        Zone.ZoneSettingProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Build.CommandProvider(),
        KeyPairProvider(),
        RandomProvider(),
      ),
    ),
    Layer.provideMerge(localRuntimeServices()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.provideMerge(Access.AccessLive),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    // Apply a blanket retry policy to every Cloudflare API call. Extends
    // `Retry.makeDefault`'s transient detection (throttling / 5xx /
    // network) with one Cloudflare-specific misleadingly-tagged
    // transient case the SDK doesn't yet mark retryable — see
    // `cloudflareRetryFactory` below. Without this, the matching brief
    // CF infrastructure blips surface as test failures and resource
    // leaks.
    //
    // Deliberately narrow: we ONLY add cases where the message
    // unambiguously indicates a transient infrastructure failure (not
    // a real auth/permission failure). Auto-retrying ambiguous cases
    // like `Unauthorized: Authentication error` would silently loop on
    // genuinely invalid tokens.
    //
    // TODO(distilled): once
    // https://github.com/alchemy-run/distilled/pull/233 lands, this
    // wrapper can collapse back to `Retry.makeDefault`.
    Layer.provideMerge(Layer.succeed(Retry.Retry, cloudflareRetryFactory)),
    Layer.orDie,
  );

const cloudflareRetryFactory: Retry.Factory = (lastError) => {
  const defaults = Retry.makeDefault(lastError);
  return {
    while: (error) =>
      defaults.while?.(error) === true || isMisleadinglyTaggedTransient(error),
    schedule: pipe(
      Schedule.exponential(Duration.millis(250), 2),
      Schedule.modifyDelay(
        Effect.fnUntraced(function* (duration) {
          const error = yield* Ref.get(lastError);
          // Throttling errors (429): honor a 500ms floor matching the
          // distilled default.
          const isThrottling =
            (error as { _tag?: unknown })?._tag === "TooManyRequests";
          if (isThrottling && Duration.toMillis(duration) < 500) {
            return Duration.toMillis(Duration.millis(500));
          }
          return Duration.toMillis(duration);
        }),
      ),
      Retry.capped(Duration.seconds(5)),
      Retry.jittered,
      Schedule.both(Schedule.recurs(8)),
    ),
  };
};

const isMisleadinglyTaggedTransient = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const tag = (error as { _tag?: unknown })._tag;
  const message = ((error as { message?: unknown }).message ?? "") as string;
  // CF code 10001: "Method not allowed for token" is a real permission
  // failure (NOT retryable), but the same code is also returned with
  // message "internal error" during Cloudflare-side hiccups. The two
  // messages are unambiguously distinct, so we can safely retry only
  // the internal-error variant.
  if (tag === "Forbidden" && /internal error/i.test(message)) return true;
  return false;
};
