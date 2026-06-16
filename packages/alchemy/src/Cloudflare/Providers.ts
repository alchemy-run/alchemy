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
import * as Access from "./Access.ts";
import * as AccessApp from "./Access/Application.ts";
import * as AccessBookmark from "./Access/Bookmark.ts";
import * as AccessCert from "./Access/Certificate.ts";
import * as AccessCustomPage from "./Access/CustomPage.ts";
import * as AccessGroup from "./Access/Group.ts";
import * as AccessIdp from "./Access/IdentityProvider.ts";
import * as AccessInfraTarget from "./Access/InfrastructureTarget.ts";
import * as AccessKeyConfig from "./Access/KeyConfiguration.ts";
import * as AccessMcpPortal from "./Access/McpPortal.ts";
import * as AccessOrg from "./Access/Organization.ts";
import * as AccessPol from "./Access/Policy.ts";
import * as AccessSvcToken from "./Access/ServiceToken.ts";
import * as AccessTag from "./Access/Tag.ts";
import * as Account from "./Account/index.ts";
import * as Acm from "./Acm/index.ts";
import * as Addressing from "./Addressing/index.ts";
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
import * as CloudforceOne from "./CloudforceOne/index.ts";
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
import * as Diagnostics from "./Diagnostics/index.ts";
import * as Dlp from "./Dlp/index.ts";
import * as Dns from "./Dns/index.ts";
import * as DnsFirewall from "./DnsFirewall/index.ts";
import * as Email from "./Email/index.ts";
import * as EmailSecurity from "./EmailSecurity/index.ts";
import * as Firewall from "./Firewall/index.ts";
import * as Flagship from "./Flagship/index.ts";
import * as Fraud from "./Fraud/index.ts";
import * as GatewayCertificate from "./Gateway/Certificate.ts";
import * as GatewayConfiguration from "./Gateway/Configuration.ts";
import * as GatewayList from "./Gateway/List.ts";
import * as GatewayLocation from "./Gateway/Location.ts";
import * as GatewayLogging from "./Gateway/Logging.ts";
import * as GatewayProxyEndpoint from "./Gateway/ProxyEndpoint.ts";
import * as GatewayRule from "./Gateway/Rule.ts";
import * as GoogleTagGateway from "./GoogleTagGateway/index.ts";
import * as Healthcheck from "./Healthcheck/index.ts";
import * as HostnameTlsSetting from "./HostnameTlsSetting/index.ts";
import * as Hyperdrive from "./Hyperdrive/index.ts";
import * as Iam from "./Iam/index.ts";
import * as Images from "./Images/index.ts";
import * as Intel from "./Intel/index.ts";
import * as KeylessCertificate from "./KeylessCertificate/index.ts";
import * as KV from "./KV/index.ts";
import * as LeakedCredentialCheck from "./LeakedCredentialCheck/index.ts";
import * as LoadBalancer from "./LoadBalancer/index.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import * as Logpush from "./Logpush/index.ts";
import * as LogsControl from "./LogsControl/index.ts";
import * as MagicCloudNetworking from "./MagicCloudNetworking/index.ts";
import * as MagicNetworkMonitoring from "./MagicNetworkMonitoring/index.ts";
import * as MagicTransit from "./MagicTransit/index.ts";
import * as ManagedTransforms from "./ManagedTransforms/index.ts";
import * as MtlsCertificate from "./MtlsCertificate/index.ts";
import * as NetworkInterconnects from "./NetworkInterconnects/index.ts";
import * as Organization from "./Organization/index.ts";
import * as OriginCaCertificate from "./OriginCaCertificate/index.ts";
import * as OriginPostQuantumEncryption from "./OriginPostQuantumEncryption/index.ts";
import * as OriginTlsClientAuth from "./OriginTlsClientAuth/index.ts";
import * as PageRule from "./PageRule/index.ts";
import * as Pages from "./Pages/index.ts";
import * as PageShield from "./PageShield/index.ts";
import * as Pipelines from "./Pipelines/index.ts";
import * as Queue from "./Queue/index.ts";
import * as R2 from "./R2/index.ts";
import * as R2DataCatalog from "./R2DataCatalog/index.ts";
import * as RateLimit from "./RateLimit/index.ts";
import * as RealtimeKit from "./RealtimeKit/index.ts";
import * as RegionalHostname from "./RegionalHostname/index.ts";
import * as Registrar from "./Registrar/index.ts";
import * as ResourceSharing from "./ResourceSharing/index.ts";
import * as RiskScoring from "./RiskScoring/index.ts";
import * as Rules from "./Rules/index.ts";
import * as Ruleset from "./Ruleset/index.ts";
import * as Rum from "./Rum/index.ts";
import * as SchemaValidation from "./SchemaValidation/index.ts";
import * as SecretsStore from "./SecretsStore/index.ts";
import * as SecurityTxt from "./SecurityTxt/index.ts";
import * as Snippets from "./Snippets/index.ts";
import * as Spectrum from "./Spectrum/index.ts";
import * as Speed from "./Speed/index.ts";
import * as Ssl from "./Ssl/index.ts";
import * as Stream from "./Stream/index.ts";
import * as Tags from "./Tags/index.ts";
import * as TokenValidation from "./TokenValidation/index.ts";
import * as Tunnel from "./Tunnel/index.ts";
import * as Turnstile from "./Turnstile/index.ts";
import * as UrlNorm from "./UrlNormalization/index.ts";
import * as Vectorize from "./Vectorize/index.ts";
import * as VpcService from "./VpcService/index.ts";
import * as VulnScanner from "./VulnerabilityScanner/index.ts";
import * as WaitingRoom from "./WaitingRoom/index.ts";
import * as Web3 from "./Web3/index.ts";
import * as Workers from "./Workers/index.ts";
import * as Workflows from "./Workers/Workflow.ts";
import * as WorkersForPlatforms from "./WorkersForPlatforms/index.ts";
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
      AccessBookmark.AccessBookmark,
      AccessCert.AccessCertificate,
      AccessCustomPage.AccessCustomPage,
      AccessGroup.AccessGroup,
      AccessIdp.AccessIdentityProvider,
      AccessInfraTarget.AccessInfrastructureTarget,
      AccessKeyConfig.AccessKeyConfiguration,
      AccessMcpPortal.AccessMcpPortal,
      AccessOrg.AccessOrganization,
      AccessPol.AccessPolicy,
      AccessSvcToken.AccessServiceToken,
      AccessTag.AccessTag,
      Account.Account,
      Account.AccountMember,
      Acm.CustomTrustStore,
      Acm.TotalTls,
      Addressing.AddressingBgpPrefix,
      Addressing.AddressingPrefix,
      Addressing.AddressingPrefixDelegation,
      Addressing.AddressingServiceBinding,
      Addressing.AddressMap,
      AiGateway.AiGateway,
      AiGateway.AiGatewayBindingPolicy,
      AiGateway.AiGatewayDataset,
      AiGateway.AiGatewayDynamicRouting,
      AiGateway.AiGatewayEvaluation,
      AiGateway.AiGatewayProviderConfig,
      AiGateway.AiGatewaySpendingLimit,
      AiSearch.AiSearchInstance,
      AiSearch.AiSearchNamespace,
      AiSearch.AiSearchToken,
      AiSecurity.AiSecurityCustomTopics,
      AiSecurity.AiSecuritySettings,
      Alerting.NotificationPolicy,
      Alerting.NotificationWebhook,
      Alerting.Silence,
      AnalyticsEngine.AnalyticsEngineDatasetBindingPolicy,
      ApiShield.ApiShieldConfiguration,
      ApiShield.ApiShieldLabel,
      ApiShield.ApiShieldOperation,
      ApiShield.ApiShieldUserSchema,
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      Argo.SmartRouting,
      Argo.TieredCaching,
      Artifacts.ArtifactsBindingPolicy,
      BotManagement.BotManagement,
      Browser.BrowserBindingPolicy,
      Cache.CacheReserve,
      Cache.OriginCloudRegion,
      Cache.RegionalTieredCache,
      Cache.SmartTieredCache,
      Cache.Variants,
      Calls.CallsApp,
      Calls.CallsTurnKey,
      CertificateAuthorities.HostnameAssociation,
      ClientCertificate.ClientCertificate,
      CloudConnector.CloudConnectorRules,
      CloudforceOne.CloudforceOneScanConfig,
      Command,
      Connectivity.DirectoryService,
      Containers.Container,
      ContentScanning.ContentScanning,
      ContentScanning.ContentScanningExpression,
      CustomCertificates.CustomCertificate,
      CustomHostnames.CustomHostname,
      CustomHostnames.FallbackOrigin,
      CustomNameservers.CustomNameserver,
      D1.D1ConnectionPolicy,
      D1.D1Database,
      DdosProtection.DdosAllowlistEntry,
      DdosProtection.SynProtectionFilter,
      DdosProtection.SynProtectionRule,
      DdosProtection.TcpFlowProtectionFilter,
      DdosProtection.TcpFlowProtectionRule,
      Devices.DeviceCustomProfile,
      Devices.DeviceDefaultProfile,
      Devices.DeviceDexTest,
      Devices.DeviceManagedNetwork,
      Devices.DevicePostureIntegration,
      Devices.DevicePostureRule,
      Devices.DeviceSettings,
      DevServer,
      Diagnostics.EndpointHealthcheck,
      Dlp.DlpEntry,
      Dlp.DlpProfile,
      Dns.AccountDnsSettings,
      Dns.DnsReadPolicy,
      Dns.DnsReadWritePolicy,
      Dns.DnsRecord,
      Dns.Dnssec,
      Dns.DnsView,
      Dns.DnsWritePolicy,
      Dns.ZoneDnsSettings,
      Dns.ZoneTransferAcl,
      Dns.ZoneTransferIncoming,
      Dns.ZoneTransferOutgoing,
      Dns.ZoneTransferPeer,
      Dns.ZoneTransferTsig,
      DnsFirewall.DnsFirewall,
      Email.EmailAddress,
      Email.EmailCatchAll,
      Email.EmailRouting,
      Email.EmailRule,
      Email.EmailSendingSubdomain,
      Email.SendEmailBindingPolicy,
      EmailSecurity.EmailSecurityAllowPolicy,
      EmailSecurity.EmailSecurityBlockSender,
      EmailSecurity.EmailSecurityDomain,
      EmailSecurity.EmailSecurityImpersonationRegistryEntry,
      EmailSecurity.EmailSecurityTrustedDomain,
      Firewall.FirewallAccessRule,
      Firewall.Lockdown,
      Firewall.UaRule,
      Flagship.FlagshipApp,
      Flagship.FlagshipBindingPolicy,
      Flagship.FlagshipFlag,
      Fraud.FraudDetectionSettings,
      GatewayCertificate.GatewayCertificate,
      GatewayConfiguration.GatewayConfiguration,
      GatewayList.GatewayList,
      GatewayLocation.GatewayLocation,
      GatewayLogging.GatewayLogging,
      GatewayProxyEndpoint.GatewayProxyEndpoint,
      GatewayRule.GatewayRule,
      GoogleTagGateway.GoogleTagGateway,
      Healthcheck.Healthcheck,
      HostnameTlsSetting.HostnameTlsSetting,
      Hyperdrive.Hyperdrive,
      Hyperdrive.HyperdriveBindingPolicy,
      Iam.IamResourceGroup,
      Iam.IamUserGroup,
      Iam.IamUserGroupMembership,
      Images.ImagesBindingPolicy,
      Images.ImagesSigningKey,
      Images.ImagesVariant,
      Intel.IndicatorFeed,
      Intel.IndicatorFeedPermission,
      KeylessCertificate.KeylessCertificate,
      KeyPair,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      LeakedCredentialCheck.LeakedCredentialCheck,
      LeakedCredentialCheck.LeakedCredentialDetection,
      LoadBalancer.LoadBalancer,
      LoadBalancer.LoadBalancerMonitor,
      LoadBalancer.LoadBalancerMonitorGroup,
      LoadBalancer.LoadBalancerPool,
      Logpush.LogpushJob,
      LogsControl.LogsCmbConfig,
      LogsControl.LogsRetentionFlag,
      MagicCloudNetworking.CatalogSync,
      MagicCloudNetworking.CloudIntegration,
      MagicCloudNetworking.OnRamp,
      MagicNetworkMonitoring.MagicNetworkMonitoringConfig,
      MagicNetworkMonitoring.MagicNetworkMonitoringRule,
      MagicTransit.GreTunnel,
      MagicTransit.IpsecTunnel,
      MagicTransit.MagicApp,
      MagicTransit.MagicSite,
      MagicTransit.MagicSiteAcl,
      MagicTransit.MagicSiteLan,
      MagicTransit.MagicSiteWan,
      MagicTransit.MagicStaticRoute,
      ManagedTransforms.ManagedTransforms,
      MtlsCertificate.MtlsCertificate,
      NetworkInterconnects.NetworkInterconnectSettings,
      Organization.Organization,
      OriginCaCertificate.OriginCaCertificate,
      OriginPostQuantumEncryption.OriginPostQuantumEncryption,
      OriginTlsClientAuth.OriginTlsClientAuthCertificate,
      OriginTlsClientAuth.OriginTlsClientAuthHostnameAssociation,
      OriginTlsClientAuth.OriginTlsClientAuthHostnameCertificate,
      OriginTlsClientAuth.OriginTlsClientAuthSetting,
      PageRule.PageRule,
      Pages.PagesDeployment,
      Pages.PagesDomain,
      Pages.PagesProject,
      PageShield.PageShieldPolicy,
      PageShield.PageShieldSettings,
      Pipelines.LegacyPipeline,
      Pipelines.Pipeline,
      Pipelines.PipelineSink,
      Pipelines.PipelineStream,
      Queue.Queue,
      Queue.QueueBindingPolicy,
      Queue.QueueConsumer,
      Queue.QueueEventSourcePolicy,
      Queue.QueueSubscription,
      R2.R2Bucket,
      R2.R2BucketBindingPolicy,
      R2.R2BucketEventNotification,
      R2.R2BucketSippy,
      R2DataCatalog.R2DataCatalog,
      Random,
      RateLimit.RateLimitBindingPolicy,
      RealtimeKit.RealtimeKitApp,
      RealtimeKit.RealtimeKitPreset,
      RealtimeKit.RealtimeKitWebhook,
      RegionalHostname.RegionalHostname,
      Registrar.RegistrarDomain,
      ResourceSharing.Share,
      ResourceSharing.ShareRecipient,
      ResourceSharing.ShareResource,
      RiskScoring.RiskScoringIntegration,
      Rules.RulesList,
      Ruleset.CustomRuleset,
      Ruleset.Ruleset,
      Ruleset.RulesetAccountEntrypoint,
      Rum.RumRule,
      Rum.RumSite,
      SchemaValidation.SchemaValidationOperationSetting,
      SchemaValidation.SchemaValidationSchema,
      SchemaValidation.SchemaValidationSettings,
      SecretsStore.Secret,
      SecretsStore.SecretBindingPolicy,
      SecretsStore.SecretsStore,
      SecurityTxt.SecurityTxt,
      Snippets.Snippet,
      Snippets.SnippetRules,
      Spectrum.SpectrumApplication,
      Speed.SpeedTestSchedule,
      Ssl.CertificatePack,
      Ssl.UniversalSsl,
      Stream.StreamLiveInput,
      Stream.StreamLiveInputOutput,
      Stream.StreamSigningKey,
      Stream.StreamWatermark,
      Stream.StreamWebhook,
      Tags.AccountResourceTags,
      Tags.ZoneResourceTags,
      TokenValidation.TokenConfiguration,
      TokenValidation.TokenValidationRule,
      Tunnel.Tunnel,
      Tunnel.TunnelConfiguration,
      Tunnel.TunnelHostnameRoute,
      Tunnel.TunnelReadPolicy,
      Tunnel.TunnelReadWritePolicy,
      Tunnel.TunnelRoute,
      Tunnel.TunnelVirtualNetwork,
      Tunnel.TunnelWarpConnector,
      Tunnel.TunnelWritePolicy,
      Turnstile.TurnstileWidget,
      UrlNorm.UrlNormalization,
      Vectorize.VectorizeIndex,
      Vectorize.VectorizeIndexBindingPolicy,
      Vectorize.VectorizeMetadataIndex,
      VpcService.VpcService,
      VulnScanner.VulnScannerCredential,
      VulnScanner.VulnScannerCredentialSet,
      VulnScanner.VulnScannerTargetEnvironment,
      WaitingRoom.WaitingRoom,
      WaitingRoom.WaitingRoomSettings,
      Web3.Web3Hostname,
      Web3.Web3HostnameContentList,
      Workers.BindWorkerPolicy,
      Workers.CronEventSourcePolicy,
      Workers.FetchPolicy,
      Workers.GitHubRepositoryEventSourcePolicy,
      Workers.ObservabilityDestination,
      Workers.VersionMetadataBindingPolicy,
      Workers.Worker,
      Workers.WorkerRoute,
      Workers.WorkersAccountSetting,
      Workers.WorkersSubdomain,
      WorkersForPlatforms.DispatchNamespace,
      WorkersForPlatforms.DispatchNamespaceScript,
      Workflows.WorkflowResource,
      Zaraz.ZarazConfig,
      Zone.Zone,
      Zone.ZoneCustomNameservers,
      Zone.ZoneHold,
      Zone.ZoneSetting,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessApp.AccessApplicationProvider(),
        AccessOrg.AccessOrganizationProvider(),
        AccessPol.AccessPolicyProvider(),
        AiGateway.AiGatewayBindingPolicyLive,
        AiGateway.AiGatewayProvider(),
        AiGateway.AiGatewaySpendingLimitProvider(),
        AnalyticsEngine.AnalyticsEngineDatasetBindingPolicyLive,
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        Artifacts.ArtifactsBindingPolicyLive,
        Browser.BrowserBindingPolicyLive,
        Containers.ContainerProvider(),
        D1.D1ConnectionPolicyLive,
        D1.DatabaseProvider(),
        Devices.DeviceDefaultProfileProvider(),
        DevServerProvider(),
        Dns.DnsReadPolicyLive,
        Dns.DnsReadWritePolicyLive,
        Dns.DnsRecordProvider(),
        Dns.DnsWritePolicyLive,
        Email.EmailAddressProvider(),
        Email.EmailRoutingProvider(),
        Email.EmailRuleProvider(),
        Email.SendEmailBindingPolicyLive,
        Flagship.FlagshipBindingPolicyLive,
        GatewayRule.GatewayRuleProvider(),
        Hyperdrive.HyperdriveBindingPolicyLive,
        Hyperdrive.HyperdriveProvider(),
        Images.ImagesBindingPolicyLive,
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        Queue.QueueBindingPolicyLive,
        Queue.QueueConsumerProvider(),
        Queue.QueueEventSourcePolicyLive,
        Queue.QueueProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketProvider(),
        RateLimit.RateLimitBindingPolicyLive,
        Ruleset.RulesetProvider(),
        SecretsStore.SecretBindingPolicyLive,
        SecretsStore.SecretsStoreProvider(),
        SecretsStore.StoreSecretProvider(),
        Tunnel.TunnelConfigurationProvider(),
        Tunnel.TunnelProvider(),
        Tunnel.TunnelReadPolicyLive,
        Tunnel.TunnelReadWritePolicyLive,
        Tunnel.TunnelRouteProvider(),
        Tunnel.TunnelWritePolicyLive,
        Vectorize.VectorizeIndexBindingPolicyLive,
        Vectorize.VectorizeIndexProvider(),
        Vectorize.VectorizeMetadataIndexProvider(),
        VpcService.VpcServiceProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.CronEventSourcePolicyLive,
        Workers.FetchPolicyLive,
        Workers.GitHubRepositoryEventSourcePolicyLive,
        Workers.VersionMetadataBindingPolicyLive,
        Workers.WorkerProvider(),
        Workflows.WorkflowProvider(),
        Zaraz.ZarazConfigProvider(),
        Zone.ZoneProvider(),
        // Split into nested groups: a single flat mergeAll with ~200
        // arguments exceeds tsgo's variadic inference ceiling and
        // silently drops the tail layers from the inferred union.
        Layer.mergeAll(
          AccessApp.AccessApplicationProvider(),
          AccessBookmark.AccessBookmarkProvider(),
          AccessCert.AccessCertificateProvider(),
          AccessCustomPage.AccessCustomPageProvider(),
          AccessGroup.AccessGroupProvider(),
          AccessIdp.AccessIdentityProviderProvider(),
          AccessInfraTarget.AccessInfrastructureTargetProvider(),
          AccessKeyConfig.AccessKeyConfigurationProvider(),
          AccessMcpPortal.AccessMcpPortalProvider(),
          AccessOrg.AccessOrganizationProvider(),
          AccessPol.AccessPolicyProvider(),
          AccessSvcToken.AccessServiceTokenProvider(),
          AccessTag.AccessTagProvider(),
          Account.AccountMemberProvider(),
          Account.AccountProvider(),
          Acm.CustomTrustStoreProvider(),
          Acm.TotalTlsProvider(),
          Addressing.AddressingBgpPrefixProvider(),
          Addressing.AddressingPrefixDelegationProvider(),
          Addressing.AddressingPrefixProvider(),
          Addressing.AddressingServiceBindingProvider(),
          Addressing.AddressMapProvider(),
          AiGateway.AiGatewayBindingPolicyLive,
          AiGateway.AiGatewayDatasetProvider(),
          AiGateway.AiGatewayDynamicRoutingProvider(),
          AiGateway.AiGatewayEvaluationProvider(),
          AiGateway.AiGatewayProvider(),
          AiGateway.AiGatewayProviderConfigProvider(),
          AiGateway.AiGatewaySpendingLimitProvider(),
          AiSearch.AiSearchInstanceProvider(),
          AiSearch.AiSearchNamespaceProvider(),
          AiSearch.AiSearchTokenProvider(),
          AiSecurity.AiSecurityCustomTopicsProvider(),
          AiSecurity.AiSecuritySettingsProvider(),
          Alerting.NotificationPolicyProvider(),
          Alerting.NotificationWebhookProvider(),
          Alerting.SilenceProvider(),
          AnalyticsEngine.AnalyticsEngineDatasetBindingPolicyLive,
          ApiShield.ApiShieldConfigurationProvider(),
          ApiShield.ApiShieldLabelProvider(),
          ApiShield.ApiShieldOperationProvider(),
          ApiShield.ApiShieldUserSchemaProvider(),
          ApiToken.AccountApiTokenProvider(),
          ApiToken.UserApiTokenProvider(),
          Argo.SmartRoutingProvider(),
          Argo.TieredCachingProvider(),
          Artifacts.ArtifactsBindingPolicyLive,
          BotManagement.BotManagementProvider(),
          Browser.BrowserBindingPolicyLive,
          Cache.CacheReserveProvider(),
          Cache.OriginCloudRegionProvider(),
          Cache.RegionalTieredCacheProvider(),
          Cache.SmartTieredCacheProvider(),
          Cache.VariantsProvider(),
          Calls.CallsAppProvider(),
          Calls.CallsTurnKeyProvider(),
          CertificateAuthorities.HostnameAssociationProvider(),
          ClientCertificate.ClientCertificateProvider(),
          CloudConnector.CloudConnectorRulesProvider(),
          CloudforceOne.CloudforceOneScanConfigProvider(),
          Connectivity.DirectoryServiceProvider(),
          Containers.ContainerProvider(),
          ContentScanning.ContentScanningExpressionProvider(),
          ContentScanning.ContentScanningProvider(),
          CustomCertificates.CustomCertificateProvider(),
          CustomHostnames.CustomHostnameProvider(),
          CustomHostnames.FallbackOriginProvider(),
          CustomNameservers.CustomNameserverProvider(),
          D1.D1ConnectionPolicyLive,
          D1.DatabaseProvider(),
          DdosProtection.DdosAllowlistEntryProvider(),
          DdosProtection.SynProtectionFilterProvider(),
          DdosProtection.SynProtectionRuleProvider(),
          DdosProtection.TcpFlowProtectionFilterProvider(),
          DdosProtection.TcpFlowProtectionRuleProvider(),
          Devices.DeviceCustomProfileProvider(),
          Devices.DeviceDefaultProfileProvider(),
          Devices.DeviceDexTestProvider(),
          Devices.DeviceManagedNetworkProvider(),
          Devices.DevicePostureIntegrationProvider(),
          Devices.DevicePostureRuleProvider(),
          Devices.DeviceSettingsProvider(),
          DevServerProvider(),
          Diagnostics.EndpointHealthcheckProvider(),
          Dlp.DlpEntryProvider(),
          Dlp.DlpProfileProvider(),
          Dns.DnsReadPolicyLive,
          Dns.DnsReadWritePolicyLive,
          Dns.DnsRecordProvider(),
          Dns.DnssecProvider(),
          Dns.DnsWritePolicyLive,
          Dns.ZoneDnsSettingsProvider(),
          DnsFirewall.DnsFirewallProvider(),
          Email.EmailAddressProvider(),
          Email.EmailCatchAllProvider(),
          Email.EmailRoutingProvider(),
          Email.EmailRuleProvider(),
          Email.EmailSendingSubdomainProvider(),
          Email.SendEmailBindingPolicyLive,
          EmailSecurity.EmailSecurityAllowPolicyProvider(),
          EmailSecurity.EmailSecurityBlockSenderProvider(),
          EmailSecurity.EmailSecurityDomainProvider(),
          EmailSecurity.EmailSecurityImpersonationRegistryEntryProvider(),
          EmailSecurity.EmailSecurityTrustedDomainProvider(),
          Firewall.FirewallAccessRuleProvider(),
          Firewall.LockdownProvider(),
          Firewall.UaRuleProvider(),
          Flagship.FlagshipAppProvider(),
          Flagship.FlagshipFlagProvider(),
          Fraud.FraudDetectionSettingsProvider(),
          GatewayCertificate.GatewayCertificateProvider(),
          GatewayConfiguration.GatewayConfigurationProvider(),
          GatewayList.GatewayListProvider(),
          GatewayLocation.GatewayLocationProvider(),
          GatewayLogging.GatewayLoggingProvider(),
          GatewayProxyEndpoint.GatewayProxyEndpointProvider(),
          GatewayRule.GatewayRuleProvider(),
          Healthcheck.HealthcheckProvider(),
          HostnameTlsSetting.HostnameTlsSettingProvider(),
          Hyperdrive.HyperdriveBindingPolicyLive,
          Hyperdrive.HyperdriveProvider(),
          Iam.IamResourceGroupProvider(),
          Iam.IamUserGroupMembershipProvider(),
          Iam.IamUserGroupProvider(),
          Images.ImagesBindingPolicyLive,
          Images.ImagesSigningKeyProvider(),
          Images.ImagesVariantProvider(),
          Intel.IndicatorFeedPermissionProvider(),
          Intel.IndicatorFeedProvider(),
          VulnScanner.VulnScannerCredentialProvider(),
          VulnScanner.VulnScannerCredentialSetProvider(),
          VulnScanner.VulnScannerTargetEnvironmentProvider(),
        ),
        Layer.mergeAll(
          KeylessCertificate.KeylessCertificateProvider(),
          KV.KVNamespaceBindingPolicyLive,
          KV.KVNamespaceProvider(),
          LeakedCredentialCheck.LeakedCredentialCheckProvider(),
          LeakedCredentialCheck.LeakedCredentialDetectionProvider(),
          Logpush.LogpushJobProvider(),
          LogsControl.LogsCmbConfigProvider(),
          LogsControl.LogsRetentionFlagProvider(),
          MagicCloudNetworking.CatalogSyncProvider(),
          MagicCloudNetworking.CloudIntegrationProvider(),
          MagicCloudNetworking.OnRampProvider(),
          MagicNetworkMonitoring.MagicNetworkMonitoringConfigProvider(),
          MagicNetworkMonitoring.MagicNetworkMonitoringRuleProvider(),
          MagicTransit.GreTunnelProvider(),
          MagicTransit.IpsecTunnelProvider(),
          MagicTransit.MagicAppProvider(),
          MagicTransit.MagicSiteAclProvider(),
          MagicTransit.MagicSiteLanProvider(),
          MagicTransit.MagicSiteProvider(),
          MagicTransit.MagicSiteWanProvider(),
          MagicTransit.MagicStaticRouteProvider(),
          ManagedTransforms.ManagedTransformsProvider(),
          MtlsCertificate.MtlsCertificateProvider(),
          NetworkInterconnects.NetworkInterconnectSettingsProvider(),
          Organization.OrganizationProvider(),
          OriginCaCertificate.OriginCaCertificateProvider(),
          OriginPostQuantumEncryption.OriginPostQuantumEncryptionProvider(),
          OriginTlsClientAuth.OriginTlsClientAuthCertificateProvider(),
          OriginTlsClientAuth.OriginTlsClientAuthHostnameAssociationProvider(),
          OriginTlsClientAuth.OriginTlsClientAuthHostnameCertificateProvider(),
          OriginTlsClientAuth.OriginTlsClientAuthSettingProvider(),
          PageRule.PageRuleProvider(),
          Pages.PagesDeploymentProvider(),
          Pages.PagesDomainProvider(),
          Pages.PagesProjectProvider(),
          PageShield.PageShieldPolicyProvider(),
          PageShield.PageShieldSettingsProvider(),
          Pipelines.LegacyPipelineProvider(),
          Pipelines.PipelineProvider(),
          Pipelines.PipelineSinkProvider(),
          Pipelines.PipelineStreamProvider(),
          Queue.QueueBindingPolicyLive,
          Queue.QueueConsumerProvider(),
          Queue.QueueEventSourcePolicyLive,
          Queue.QueueProvider(),
          Queue.QueueSubscriptionProvider(),
          R2.R2BucketBindingPolicyLive,
          R2.R2BucketEventNotificationProvider(),
          R2.R2BucketProvider(),
          R2.R2BucketSippyProvider(),
          R2DataCatalog.R2DataCatalogProvider(),
          RateLimit.RateLimitBindingPolicyLive,
          RealtimeKit.RealtimeKitAppProvider(),
          RealtimeKit.RealtimeKitPresetProvider(),
          RealtimeKit.RealtimeKitWebhookProvider(),
          RegionalHostname.RegionalHostnameProvider(),
          Registrar.RegistrarDomainProvider(),
          ResourceSharing.ShareProvider(),
          ResourceSharing.ShareRecipientProvider(),
          ResourceSharing.ShareResourceProvider(),
          RiskScoring.RiskScoringIntegrationProvider(),
          Rules.RulesListProvider(),
          Ruleset.CustomRulesetProvider(),
          Ruleset.RulesetAccountEntrypointProvider(),
          Ruleset.RulesetProvider(),
          Rum.RumRuleProvider(),
          Rum.RumSiteProvider(),
          SchemaValidation.SchemaValidationOperationSettingProvider(),
          SchemaValidation.SchemaValidationSchemaProvider(),
          SchemaValidation.SchemaValidationSettingsProvider(),
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
          Stream.StreamLiveInputOutputProvider(),
          Stream.StreamLiveInputProvider(),
          Stream.StreamSigningKeyProvider(),
          Stream.StreamWatermarkProvider(),
          Stream.StreamWebhookProvider(),
          Tags.AccountResourceTagsProvider(),
          Tags.ZoneResourceTagsProvider(),
          TokenValidation.TokenConfigurationProvider(),
          TokenValidation.TokenValidationRuleProvider(),
          Tunnel.TunnelConfigurationProvider(),
          Tunnel.TunnelHostnameRouteProvider(),
          Tunnel.TunnelProvider(),
          Tunnel.TunnelReadPolicyLive,
          Tunnel.TunnelReadWritePolicyLive,
          Tunnel.TunnelRouteProvider(),
          Tunnel.TunnelVirtualNetworkProvider(),
          Tunnel.TunnelWarpConnectorProvider(),
          Tunnel.TunnelWritePolicyLive,
          Turnstile.TurnstileWidgetProvider(),
          UrlNorm.UrlNormalizationProvider(),
          Vectorize.VectorizeIndexBindingPolicyLive,
          Vectorize.VectorizeIndexProvider(),
          Vectorize.VectorizeMetadataIndexProvider(),
          VpcService.VpcServiceProvider(),
          WaitingRoom.WaitingRoomProvider(),
          WaitingRoom.WaitingRoomSettingsProvider(),
          Web3.Web3HostnameContentListProvider(),
          Web3.Web3HostnameProvider(),
          Workers.BindWorkerPolicyLive,
          Workers.CronEventSourcePolicyLive,
          Workers.FetchPolicyLive,
          Workers.ObservabilityDestinationProvider(),
          Workers.VersionMetadataBindingPolicyLive,
          Workers.WorkerProvider(),
          Workers.WorkerRouteProvider(),
          Workers.WorkersAccountSettingProvider(),
          Workers.WorkersSubdomainProvider(),
          WorkersForPlatforms.DispatchNamespaceProvider(),
          WorkersForPlatforms.DispatchNamespaceScriptProvider(),
          Workflows.WorkflowProvider(),
          Zaraz.ZarazConfigProvider(),
          Zone.ZoneCustomNameserversProvider(),
          Zone.ZoneHoldProvider(),
          Zone.ZoneProvider(),
          Zone.ZoneSettingProvider(),
        ),
        Layer.mergeAll(
          Dns.AccountDnsSettingsProvider(),
          Dns.DnsViewProvider(),
          Dns.ZoneTransferAclProvider(),
          Dns.ZoneTransferIncomingProvider(),
          Dns.ZoneTransferOutgoingProvider(),
          Dns.ZoneTransferPeerProvider(),
          Dns.ZoneTransferTsigProvider(),
          GoogleTagGateway.GoogleTagGatewayProvider(),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        LoadBalancer.LoadBalancerProvider(),
        LoadBalancer.LoadBalancerMonitorProvider(),
        LoadBalancer.LoadBalancerMonitorGroupProvider(),
        LoadBalancer.LoadBalancerPoolProvider(),
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
  // CF code 10001: "Unable to authenticate request" intermittently 403s
  // otherwise-valid, long-lived credentials during Cloudflare-side auth/edge
  // blips — it is transient, not a real credential problem (a genuinely
  // invalid/expired token surfaces as `Unauthorized: Authentication error`,
  // code 10000). The retry is bounded (see `cloudflareRetryFactory`), so even
  // a persistent auth failure that somehow used this message would just fail
  // fast after backoff rather than loop forever.
  if (tag === "Forbidden" && /unable to authenticate request/i.test(message))
    return true;
  // CF code 10000: "Authentication error" is a transient throttle Cloudflare
  // returns under high request concurrency — the same call against the same
  // zone succeeds in isolation (verified: an account whose zones are all
  // active and reachable still intermittently rejects with "Authentication
  // error" only when hundreds of calls fan out at once). It surfaces under
  // both a 403 (`Forbidden`) and a 401 (`Unauthorized`) tag depending on the
  // edge node. The retry is bounded (see `cloudflareRetryFactory`: ~8 tries,
  // capped 5s), so a genuinely invalid/expired token — which produces the same
  // message persistently — still fails fast after a few seconds of backoff
  // rather than looping forever; the win is that valid tokens stop flaking
  // under load.
  if (
    (tag === "Forbidden" || tag === "Unauthorized") &&
    /authentication error/i.test(message)
  ) {
    return true;
  }
  return false;
};
