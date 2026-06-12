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
import * as AccessIdp from "./Access/IdentityProvider.ts";
import * as AccessOrg from "./Access/Organization.ts";
import * as AccessPol from "./Access/Policy.ts";
import * as AccessSvcToken from "./Access/ServiceToken.ts";
import * as Account from "./Account/index.ts";
import * as Acm from "./Acm/index.ts";
import * as AiGateway from "./AiGateway/index.ts";
import * as AiSearch from "./AiSearch/index.ts";
import * as AiSecurity from "./AiSecurity/index.ts";
import * as Alerting from "./Alerting/index.ts";
import * as AnalyticsEngine from "./AnalyticsEngine/index.ts";
import * as ApiShield from "./ApiShield/index.ts";
import * as ApiToken from "./ApiToken/index.ts";
import * as Argo from "./Argo/index.ts";
import * as Artifacts from "./Artifacts/index.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as BotManagement from "./BotManagement/index.ts";
import * as Browser from "./Browser/index.ts";
import * as Cache from "./Cache/index.ts";
import * as Calls from "./Calls/index.ts";
import * as CertificateAuthorities from "./CertificateAuthorities/index.ts";
import * as ClientCertificate from "./ClientCertificate/index.ts";
import * as CloudConnector from "./CloudConnector/index.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Connectivity from "./Connectivity/index.ts";
import * as Containers from "./Container/index.ts";
import * as ContentScanning from "./ContentScanning/index.ts";
import * as Credentials from "./Credentials.ts";
import * as CustomCertificates from "./CustomCertificate/index.ts";
import * as CustomHostnames from "./CustomHostname/index.ts";
import * as CustomNameservers from "./CustomNameserver/index.ts";
import * as D1 from "./D1/index.ts";
import * as DdosProtection from "./DdosProtection/index.ts";
import * as Devices from "./Devices/index.ts";
import * as Dns from "./Dns/index.ts";
import * as Email from "./Email/index.ts";
import * as Firewall from "./Firewall/index.ts";
import * as GatewayList from "./Gateway/List.ts";
import * as GatewayLocation from "./Gateway/Location.ts";
import * as GatewayProxyEndpoint from "./Gateway/ProxyEndpoint.ts";
import * as GatewayRule from "./Gateway/Rule.ts";
import * as Healthcheck from "./Healthcheck/index.ts";
import * as HostnameTlsSetting from "./HostnameTlsSetting/index.ts";
import * as Hyperdrive from "./Hyperdrive/index.ts";
import * as Images from "./Images/index.ts";
import * as KeylessCertificate from "./KeylessCertificate/index.ts";
import * as KV from "./KV/index.ts";
import * as LeakedCredentialCheck from "./LeakedCredentialCheck/index.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import * as Logpush from "./Logpush/index.ts";
import * as MagicCloudNetworking from "./MagicCloudNetworking/index.ts";
import * as ManagedTransforms from "./ManagedTransforms/index.ts";
import * as MtlsCertificate from "./MtlsCertificate/index.ts";
import * as NetworkInterconnects from "./NetworkInterconnects/index.ts";
import * as OriginCaCertificate from "./OriginCaCertificate/index.ts";
import * as OriginPostQuantumEncryption from "./OriginPostQuantumEncryption/index.ts";
import * as OriginTlsClientAuth from "./OriginTlsClientAuth/index.ts";
import * as Pages from "./Pages/index.ts";
import * as PageRule from "./PageRule/index.ts";
import * as Pipelines from "./Pipelines/index.ts";
import * as Queue from "./Queue/index.ts";
import * as R2 from "./R2/index.ts";
import * as R2DataCatalog from "./R2DataCatalog/index.ts";
import * as RateLimit from "./RateLimit/index.ts";
import * as Registrar from "./Registrar/index.ts";
import * as Rules from "./Rules/index.ts";
import * as Rum from "./Rum/index.ts";
import * as Ruleset from "./Ruleset/index.ts";
import * as SecretsStore from "./SecretsStore/index.ts";
import * as SecurityTxt from "./SecurityTxt/index.ts";
import * as Snippets from "./Snippets/index.ts";
import * as Spectrum from "./Spectrum/index.ts";
import * as Speed from "./Speed/index.ts";
import * as Ssl from "./Ssl/index.ts";
import * as Tags from "./Tags/index.ts";
import * as Tunnel from "./Tunnel/index.ts";
import * as Turnstile from "./Turnstile/index.ts";
import * as UrlNorm from "./UrlNormalization/index.ts";
import * as Vectorize from "./Vectorize/index.ts";
import * as VpcService from "./VpcService/index.ts";
import * as WaitingRoom from "./WaitingRoom/index.ts";
import * as Web3 from "./Web3/index.ts";
import * as Workers from "./Workers/index.ts";
import * as WorkersForPlatforms from "./WorkersForPlatforms/index.ts";
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
      AccessIdp.AccessIdentityProvider,
      AccessOrg.AccessOrganization,
      AccessPol.AccessPolicy,
      AccessSvcToken.AccessServiceToken,
      Account.Account,
      Account.AccountMember,
      Acm.CustomTrustStore,
      Acm.TotalTls,
      ApiShield.ApiShieldLabel,
      ApiShield.ApiShieldOperation,
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      AiGateway.AiGateway,
      AiGateway.AiGatewaySpendingLimit,
      AiGateway.AiGatewayBindingPolicy,
      AiGateway.AiGatewayDataset,
      AiGateway.AiGatewayDynamicRouting,
      AiSearch.AiSearchInstance,
      AiSearch.AiSearchNamespace,
      AiSearch.AiSearchToken,
      AiSecurity.AiSecurityCustomTopics,
      AiSecurity.AiSecuritySettings,
      Alerting.NotificationPolicy,
      Alerting.NotificationWebhook,
      Alerting.Silence,
      AnalyticsEngine.AnalyticsEngineDatasetBindingPolicy,
      Argo.TieredCaching,
      Artifacts.ArtifactsBindingPolicy,
      BotManagement.BotManagement,
      Browser.BrowserBindingPolicy,
      Cache.CacheReserve,
      Cache.RegionalTieredCache,
      Cache.SmartTieredCache,
      Cache.Variants,
      Calls.CallsApp,
      Calls.CallsTurnKey,
      CertificateAuthorities.HostnameAssociation,
      ClientCertificate.ClientCertificate,
      Command,
      CloudConnector.CloudConnectorRules,
      Connectivity.DirectoryService,
      Containers.Container,
      ContentScanning.ContentScanning,
      ContentScanning.ContentScanningExpression,
      D1.D1ConnectionPolicy,
      CustomCertificates.CustomCertificate,
      CustomHostnames.CustomHostname,
      CustomHostnames.FallbackOrigin,
      CustomNameservers.CustomNameserver,
      D1.D1Database,
      DdosProtection.DdosAllowlistEntry,
      DdosProtection.SynProtectionFilter,
      DdosProtection.SynProtectionRule,
      DdosProtection.TcpFlowProtectionFilter,
      DdosProtection.TcpFlowProtectionRule,
      DevServer,
      Devices.DeviceDefaultProfile,
      Dns.DnsReadPolicy,
      Dns.DnsReadWritePolicy,
      Dns.DnsRecord,
      Dns.Dnssec,
      Dns.DnsWritePolicy,
      Dns.ZoneDnsSettings,
      Email.EmailAddress,
      Email.EmailCatchAll,
      Email.EmailRouting,
      Email.EmailRule,
      Email.EmailSendingSubdomain,
      Email.SendEmailBindingPolicy,
      Firewall.FirewallAccessRule,
      Firewall.Lockdown,
      Firewall.UaRule,
      GatewayList.GatewayList,
      GatewayLocation.GatewayLocation,
      GatewayProxyEndpoint.GatewayProxyEndpoint,
      GatewayRule.GatewayRule,
      Healthcheck.Healthcheck,
      HostnameTlsSetting.HostnameTlsSetting,
      Hyperdrive.Hyperdrive,
      Hyperdrive.HyperdriveBindingPolicy,
      Images.ImagesBindingPolicy,
      KeylessCertificate.KeylessCertificate,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      LeakedCredentialCheck.LeakedCredentialCheck,
      LeakedCredentialCheck.LeakedCredentialDetection,
      Logpush.LogpushJob,
      MagicCloudNetworking.CatalogSync,
      MagicCloudNetworking.CloudIntegration,
      MagicCloudNetworking.OnRamp,
      ManagedTransforms.ManagedTransforms,
      MtlsCertificate.MtlsCertificate,
      NetworkInterconnects.NetworkInterconnectSettings,
      OriginCaCertificate.OriginCaCertificate,
      OriginPostQuantumEncryption.OriginPostQuantumEncryption,
      OriginTlsClientAuth.OriginTlsClientAuthCertificate,
      OriginTlsClientAuth.OriginTlsClientAuthHostnameAssociation,
      OriginTlsClientAuth.OriginTlsClientAuthHostnameCertificate,
      OriginTlsClientAuth.OriginTlsClientAuthSetting,
      Pages.PagesDeployment,
      Pages.PagesDomain,
      Pages.PagesProject,
      PageRule.PageRule,
      Pipelines.Pipeline,
      Pipelines.PipelineSink,
      Pipelines.PipelineStream,
      Queue.Queue,
      Queue.QueueBindingPolicy,
      Queue.QueueConsumer,
      Queue.QueueEventSourcePolicy,
      Queue.QueueSubscription,
      R2.R2Bucket,
      R2DataCatalog.R2DataCatalog,
      R2.R2BucketBindingPolicy,
      R2.R2BucketEventNotification,
      RateLimit.RateLimitBindingPolicy,
      Registrar.RegistrarDomain,
      Rules.RulesList,
      Rum.RumSite,
      Ruleset.Ruleset,
      SecretsStore.SecretBindingPolicy,
      SecretsStore.SecretsStore,
      SecretsStore.Secret,
      SecurityTxt.SecurityTxt,
      Snippets.Snippet,
      Snippets.SnippetRules,
      Spectrum.SpectrumApplication,
      Speed.SpeedTestSchedule,
      Ssl.CertificatePack,
      Ssl.UniversalSsl,
      Tags.AccountResourceTags,
      Tags.ZoneResourceTags,
      Tunnel.Tunnel,
      Tunnel.TunnelConfiguration,
      Tunnel.TunnelReadPolicy,
      Tunnel.TunnelReadWritePolicy,
      Tunnel.TunnelRoute,
      Tunnel.TunnelVirtualNetwork,
      Tunnel.TunnelWritePolicy,
      Turnstile.TurnstileWidget,
      UrlNorm.UrlNormalization,
      Vectorize.VectorizeIndexBindingPolicy,
      Vectorize.VectorizeIndex,
      Vectorize.VectorizeMetadataIndex,
      VpcService.VpcService,
      WaitingRoom.WaitingRoom,
      WaitingRoom.WaitingRoomSettings,
      Web3.Web3Hostname,
      Web3.Web3HostnameContentList,
      KeyPair,
      Random,
      Workers.BindWorkerPolicy,
      Workers.CronEventSourcePolicy,
      Workers.WorkersAccountSetting,
      Workers.WorkersSubdomain,
      Workers.FetchPolicy,
      Workers.ObservabilityDestination,
      Workers.VersionMetadataBindingPolicy,
      Workers.Worker,
      Workers.WorkerRoute,
      WorkersForPlatforms.DispatchNamespace,
      WorkersForPlatforms.DispatchNamespaceScript,
      Workflows.WorkflowResource,
      Zaraz.ZarazConfig,
      Zone.Zone,
      Zone.ZoneHold,
      Zone.ZoneSetting,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessApp.AccessApplicationProvider(),
        AccessGroup.AccessGroupProvider(),
        AccessIdp.AccessIdentityProviderProvider(),
        AccessOrg.AccessOrganizationProvider(),
        AccessPol.AccessPolicyProvider(),
        AccessSvcToken.AccessServiceTokenProvider(),
        Account.AccountProvider(),
        Account.AccountMemberProvider(),
        Acm.CustomTrustStoreProvider(),
        Acm.TotalTlsProvider(),
        ApiShield.ApiShieldLabelProvider(),
        ApiShield.ApiShieldOperationProvider(),
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        AiGateway.AiGatewayProvider(),
        AiGateway.AiGatewaySpendingLimitProvider(),
        AiGateway.AiGatewayBindingPolicyLive,
        AiGateway.AiGatewayDatasetProvider(),
        AiGateway.AiGatewayDynamicRoutingProvider(),
        AiSearch.AiSearchInstanceProvider(),
        AiSearch.AiSearchNamespaceProvider(),
        AiSearch.AiSearchTokenProvider(),
        AiSecurity.AiSecurityCustomTopicsProvider(),
        AiSecurity.AiSecuritySettingsProvider(),
        Alerting.NotificationPolicyProvider(),
        Alerting.NotificationWebhookProvider(),
        Alerting.SilenceProvider(),
        AnalyticsEngine.AnalyticsEngineDatasetBindingPolicyLive,
        Argo.TieredCachingProvider(),
        Artifacts.ArtifactsBindingPolicyLive,
        BotManagement.BotManagementProvider(),
        Browser.BrowserBindingPolicyLive,
        Cache.CacheReserveProvider(),
        Cache.RegionalTieredCacheProvider(),
        Cache.SmartTieredCacheProvider(),
        Cache.VariantsProvider(),
        Calls.CallsAppProvider(),
        Calls.CallsTurnKeyProvider(),
        CertificateAuthorities.HostnameAssociationProvider(),
        ClientCertificate.ClientCertificateProvider(),
        CloudConnector.CloudConnectorRulesProvider(),
        Connectivity.DirectoryServiceProvider(),
        Containers.ContainerProvider(),
        ContentScanning.ContentScanningProvider(),
        ContentScanning.ContentScanningExpressionProvider(),
        D1.D1ConnectionPolicyLive,
        CustomCertificates.CustomCertificateProvider(),
        CustomHostnames.CustomHostnameProvider(),
        CustomHostnames.FallbackOriginProvider(),
        CustomNameservers.CustomNameserverProvider(),
        D1.DatabaseProvider(),
        DdosProtection.DdosAllowlistEntryProvider(),
        DdosProtection.SynProtectionFilterProvider(),
        DdosProtection.SynProtectionRuleProvider(),
        DdosProtection.TcpFlowProtectionFilterProvider(),
        DdosProtection.TcpFlowProtectionRuleProvider(),
        DevServerProvider(),
        Devices.DeviceDefaultProfileProvider(),
        Dns.DnsReadPolicyLive,
        Dns.DnsReadWritePolicyLive,
        Dns.DnsRecordProvider(),
        Dns.DnssecProvider(),
        Dns.DnsWritePolicyLive,
        Dns.ZoneDnsSettingsProvider(),
        Email.EmailAddressProvider(),
        Email.EmailCatchAllProvider(),
        Email.EmailRoutingProvider(),
        Email.EmailRuleProvider(),
        Email.EmailSendingSubdomainProvider(),
        Email.SendEmailBindingPolicyLive,
        Firewall.FirewallAccessRuleProvider(),
        Firewall.LockdownProvider(),
        Firewall.UaRuleProvider(),
        GatewayList.GatewayListProvider(),
        GatewayLocation.GatewayLocationProvider(),
        GatewayProxyEndpoint.GatewayProxyEndpointProvider(),
        GatewayRule.GatewayRuleProvider(),
        Healthcheck.HealthcheckProvider(),
        HostnameTlsSetting.HostnameTlsSettingProvider(),
        Hyperdrive.HyperdriveBindingPolicyLive,
        Hyperdrive.HyperdriveProvider(),
        Images.ImagesBindingPolicyLive,
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        KeylessCertificate.KeylessCertificateProvider(),
        LeakedCredentialCheck.LeakedCredentialCheckProvider(),
        LeakedCredentialCheck.LeakedCredentialDetectionProvider(),
        Logpush.LogpushJobProvider(),
        MagicCloudNetworking.CatalogSyncProvider(),
        MagicCloudNetworking.CloudIntegrationProvider(),
        MagicCloudNetworking.OnRampProvider(),
        ManagedTransforms.ManagedTransformsProvider(),
        MtlsCertificate.MtlsCertificateProvider(),
        NetworkInterconnects.NetworkInterconnectSettingsProvider(),
        OriginCaCertificate.OriginCaCertificateProvider(),
        OriginPostQuantumEncryption.OriginPostQuantumEncryptionProvider(),
        OriginTlsClientAuth.OriginTlsClientAuthCertificateProvider(),
        OriginTlsClientAuth.OriginTlsClientAuthHostnameAssociationProvider(),
        OriginTlsClientAuth.OriginTlsClientAuthHostnameCertificateProvider(),
        OriginTlsClientAuth.OriginTlsClientAuthSettingProvider(),
        Pages.PagesDeploymentProvider(),
        Pages.PagesDomainProvider(),
        Pages.PagesProjectProvider(),
        PageRule.PageRuleProvider(),
        Pipelines.PipelineProvider(),
        Pipelines.PipelineSinkProvider(),
        Pipelines.PipelineStreamProvider(),
        Queue.QueueBindingPolicyLive,
        Queue.QueueEventSourcePolicyLive,
        Queue.QueueProvider(),
        Queue.QueueConsumerProvider(),
        Queue.QueueSubscriptionProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketEventNotificationProvider(),
        R2.R2BucketProvider(),
        R2DataCatalog.R2DataCatalogProvider(),
        RateLimit.RateLimitBindingPolicyLive,
        Registrar.RegistrarDomainProvider(),
        Rules.RulesListProvider(),
        Rum.RumSiteProvider(),
        Ruleset.RulesetProvider(),
        SecretsStore.SecretBindingPolicyLive,
        SecretsStore.SecretsStoreProvider(),
        SecretsStore.StoreSecretProvider(),
        SecurityTxt.SecurityTxtProvider(),
        Snippets.SnippetProvider(),
        Snippets.SnippetRulesProvider(),
        Spectrum.SpectrumApplicationProvider(),
        Speed.SpeedTestScheduleProvider(),
        Ssl.CertificatePackProvider(),
        Ssl.UniversalSslProvider(),
        Tags.AccountResourceTagsProvider(),
        Tags.ZoneResourceTagsProvider(),
        Tunnel.TunnelProvider(),
        Tunnel.TunnelConfigurationProvider(),
        Tunnel.TunnelReadPolicyLive,
        Tunnel.TunnelReadWritePolicyLive,
        Tunnel.TunnelRouteProvider(),
        Tunnel.TunnelVirtualNetworkProvider(),
        Tunnel.TunnelWritePolicyLive,
        Turnstile.TurnstileWidgetProvider(),
        UrlNorm.UrlNormalizationProvider(),
        Vectorize.VectorizeIndexBindingPolicyLive,
        Vectorize.VectorizeIndexProvider(),
        Vectorize.VectorizeMetadataIndexProvider(),
        VpcService.VpcServiceProvider(),
        WaitingRoom.WaitingRoomProvider(),
        WaitingRoom.WaitingRoomSettingsProvider(),
        Web3.Web3HostnameProvider(),
        Web3.Web3HostnameContentListProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.CronEventSourcePolicyLive,
        Workers.WorkersAccountSettingProvider(),
        Workers.WorkersSubdomainProvider(),
        Workers.FetchPolicyLive,
        Workers.ObservabilityDestinationProvider(),
        Workers.VersionMetadataBindingPolicyLive,
        Workers.WorkerProvider(),
        Workers.WorkerRouteProvider(),
        WorkersForPlatforms.DispatchNamespaceProvider(),
        WorkersForPlatforms.DispatchNamespaceScriptProvider(),
        Workflows.WorkflowProvider(),
        Zaraz.ZarazConfigProvider(),
        Zone.ZoneHoldProvider(),
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
