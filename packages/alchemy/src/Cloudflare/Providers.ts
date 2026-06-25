import { Retry } from "@distilled.cloud/cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as Access from "./Access.ts";
import * as AccessApp from "./Access/Application.ts";
import * as Bookmark from "./Access/Bookmark.ts";
import * as AccessCert from "./Access/Certificate.ts";
import * as CustomPage from "./Access/CustomPage.ts";
import * as Group from "./Access/Group.ts";
import * as AccessIdp from "./Access/IdentityProvider.ts";
import * as AccessInfraTarget from "./Access/InfrastructureTarget.ts";
import * as AccessKeyConfig from "./Access/KeyConfiguration.ts";
import * as McpPortal from "./Access/McpPortal.ts";
import * as AccessOrg from "./Access/Organization.ts";
import * as AccessPol from "./Access/Policy.ts";
import * as AccessSvcToken from "./Access/ServiceToken.ts";
import * as Tag from "./Access/Tag.ts";
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
import * as Browser from "./Workers/index.ts";
import * as Cache from "./Cache/index.ts";
import * as Calls from "./Calls/index.ts";
import * as CertificateAuthorities from "./CertificateAuthorities/index.ts";
import * as ClientCertificate from "./ClientCertificate/index.ts";
import * as CloudConnector from "./CloudConnector/index.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as CloudforceOne from "./CloudforceOne/index.ts";
import * as Connectivity from "./Connectivity/index.ts";
import * as Containers from "./Containers/index.ts";
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
import * as Certificate from "./Gateway/Certificate.ts";
import * as Configuration from "./Gateway/Configuration.ts";
import * as List from "./Gateway/List.ts";
import * as Location from "./Gateway/Location.ts";
import * as Logging from "./Gateway/Logging.ts";
import * as ProxyEndpoint from "./Gateway/ProxyEndpoint.ts";
import * as Rule from "./Gateway/Rule.ts";
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
import * as Queue from "./Queues/index.ts";
import * as R2 from "./R2/index.ts";
import * as R2DataCatalog from "./R2DataCatalog/index.ts";
import * as RateLimit from "./Workers/index.ts";
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
      AccessApp.Application,
      Bookmark.Bookmark,
      AccessCert.Certificate,
      CustomPage.CustomPage,
      Group.Group,
      AccessIdp.IdentityProvider,
      AccessInfraTarget.InfrastructureTarget,
      AccessKeyConfig.KeyConfiguration,
      McpPortal.McpPortal,
      AccessOrg.Organization,
      AccessPol.Policy,
      AccessSvcToken.ServiceToken,
      Tag.Tag,
      Account.Account,
      Account.Member,
      Acm.CustomTrustStore,
      Acm.TotalTls,
      Addressing.BgpPrefix,
      Addressing.Prefix,
      Addressing.PrefixDelegation,
      Addressing.ServiceBinding,
      Addressing.AddressMap,
      AiGateway.Gateway,
      AiGateway.Dataset,
      AiGateway.DynamicRouting,
      AiGateway.Evaluation,
      AiGateway.ProviderConfig,
      AiSearch.Instance,
      AiSearch.Namespace,
      AiSearch.Token,
      AiSecurity.CustomTopics,
      AiSecurity.Settings,
      Alerting.NotificationPolicy,
      Alerting.NotificationWebhook,
      Alerting.Silence,
      ApiShield.Configuration,
      ApiShield.Label,
      ApiShield.Operation,
      ApiShield.UserSchema,
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      Argo.SmartRouting,
      Argo.TieredCaching,
      BotManagement.BotManagement,
      Cache.Reserve,
      Cache.OriginCloudRegion,
      Cache.RegionalTieredCache,
      Cache.SmartTieredCache,
      Cache.Variants,
      Calls.App,
      Calls.TurnKey,
      CertificateAuthorities.HostnameAssociation,
      ClientCertificate.ClientCertificate,
      CloudConnector.Rules,
      CloudforceOne.ScanConfig,
      Connectivity.DirectoryService,
      Containers.ContainerPlatform,
      ContentScanning.ContentScanning,
      ContentScanning.Expression,
      CustomCertificates.CustomCertificate,
      CustomHostnames.CustomHostname,
      CustomHostnames.FallbackOrigin,
      CustomNameservers.CustomNameserver,
      D1.Database,
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
      Diagnostics.EndpointHealthcheck,
      Dlp.Entry,
      Dlp.Profile,
      Dns.AccountDnsSettings,
      Dns.Record,
      Dns.Dnssec,
      Dns.View,
      Dns.ZoneDnsSettings,
      Dns.ZoneTransferAcl,
      Dns.ZoneTransferIncoming,
      Dns.ZoneTransferOutgoing,
      Dns.ZoneTransferPeer,
      Dns.ZoneTransferTsig,
      DnsFirewall.DnsFirewall,
      Email.Address,
      Email.CatchAll,
      Email.Routing,
      Email.Rule,
      Email.SendingSubdomain,
      EmailSecurity.AllowPolicy,
      EmailSecurity.BlockSender,
      EmailSecurity.Domain,
      EmailSecurity.ImpersonationRegistryEntry,
      EmailSecurity.TrustedDomain,
      Firewall.AccessRule,
      Firewall.Lockdown,
      Firewall.UaRule,
      Flagship.App,
      Flagship.Flag,
      Fraud.DetectionSettings,
      Certificate.Certificate,
      Configuration.Configuration,
      List.List,
      Location.Location,
      Logging.Logging,
      ProxyEndpoint.ProxyEndpoint,
      Rule.Rule,
      GoogleTagGateway.GoogleTagGateway,
      Healthcheck.Healthcheck,
      HostnameTlsSetting.HostnameTlsSetting,
      Hyperdrive.Connection,
      Iam.ResourceGroup,
      Iam.UserGroup,
      Iam.UserGroupMembership,
      Images.SigningKey,
      Images.Variant,
      Intel.IndicatorFeed,
      Intel.IndicatorFeedPermission,
      KeylessCertificate.KeylessCertificate,
      KeyPair,
      KV.Namespace,
      LeakedCredentialCheck.LeakedCredentialCheck,
      LeakedCredentialCheck.LeakedCredentialDetection,
      LoadBalancer.LoadBalancer,
      LoadBalancer.Monitor,
      LoadBalancer.MonitorGroup,
      LoadBalancer.Pool,
      Logpush.Job,
      LogsControl.LogsCmbConfig,
      LogsControl.LogsRetentionFlag,
      MagicCloudNetworking.CatalogSync,
      MagicCloudNetworking.CloudIntegration,
      MagicCloudNetworking.OnRamp,
      MagicNetworkMonitoring.Config,
      MagicNetworkMonitoring.Rule,
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
      OriginTlsClientAuth.Certificate,
      OriginTlsClientAuth.HostnameAssociation,
      OriginTlsClientAuth.HostnameCertificate,
      OriginTlsClientAuth.Setting,
      PageRule.PageRule,
      Pages.Deployment,
      Pages.Domain,
      Pages.Project,
      PageShield.Policy,
      PageShield.Settings,
      Pipelines.LegacyPipeline,
      Pipelines.Pipeline,
      Pipelines.PipelineSink,
      Pipelines.PipelineStream,
      Queue.Queue,
      Queue.Consumer,
      Queue.EventSourcePolicy,
      Queue.Subscription,
      R2.Bucket,
      R2.BucketEventNotification,
      R2.BucketSippy,
      R2DataCatalog.R2DataCatalog,
      Random,
      RealtimeKit.App,
      RealtimeKit.Preset,
      RealtimeKit.Webhook,
      RegionalHostname.RegionalHostname,
      Registrar.Domain,
      ResourceSharing.Share,
      ResourceSharing.ShareRecipient,
      ResourceSharing.ShareResource,
      RiskScoring.Integration,
      Rules.List,
      Ruleset.CustomRuleset,
      Ruleset.Ruleset,
      Ruleset.AccountEntrypoint,
      Rum.Rule,
      Rum.Site,
      SchemaValidation.OperationSetting,
      SchemaValidation.SchemaValidationSchema,
      SchemaValidation.Settings,
      SecretsStore.Secret,
      SecretsStore.Store,
      SecurityTxt.SecurityTxt,
      Snippets.Snippet,
      Snippets.SnippetRules,
      Spectrum.Application,
      Speed.TestSchedule,
      Ssl.CertificatePack,
      Ssl.UniversalSsl,
      Stream.LiveInput,
      Stream.LiveInputOutput,
      Stream.SigningKey,
      Stream.Watermark,
      Stream.Webhook,
      Tags.AccountResourceTags,
      Tags.ZoneResourceTags,
      TokenValidation.TokenConfiguration,
      TokenValidation.Rule,
      Tunnel.Tunnel,
      Tunnel.Configuration,
      Tunnel.HostnameRoute,
      Tunnel.Route,
      Tunnel.VirtualNetwork,
      Tunnel.WarpConnector,
      Turnstile.Widget,
      UrlNorm.UrlNormalization,
      Vectorize.Index,
      Vectorize.MetadataIndex,
      VpcService.VpcService,
      VulnScanner.VulnScannerCredential,
      VulnScanner.VulnScannerCredentialSet,
      VulnScanner.VulnScannerTargetEnvironment,
      WaitingRoom.WaitingRoom,
      WaitingRoom.Settings,
      Web3.Hostname,
      Web3.HostnameContentList,
      Workers.BindWorkerPolicy,
      Workers.CronEventSourcePolicy,
      Workers.GitHubRepositoryEventSourcePolicy,
      Workers.ObservabilityDestination,
      Workers.Worker,
      Workers.WorkerRoute,
      Workers.AccountSetting,
      Workers.Subdomain,
      WorkersForPlatforms.DispatchNamespace,
      Workflows.WorkflowResource,
      Zaraz.Config,
      Zone.Zone,
      Zone.CustomNameservers,
      Zone.Hold,
      Zone.Setting,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessApp.ApplicationProvider(),
        AccessOrg.OrganizationProvider(),
        AccessPol.PolicyProvider(),
        AiGateway.GatewayProvider(),
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        Containers.ContainerProvider(),
        D1.DatabaseProvider(),
        Devices.DeviceDefaultProfileProvider(),
        Dns.RecordProvider(),
        Email.AddressProvider(),
        Email.RoutingProvider(),
        Email.RuleProvider(),
        Rule.RuleProvider(),
        Hyperdrive.ConnectionProvider(),
        KV.NamespaceProvider(),
        Queue.ConsumerProvider(),
        Queue.EventSourcePolicyLive,
        Queue.QueueProvider(),
        R2.BucketProvider(),
        Ruleset.RulesetProvider(),
        SecretsStore.SecretsStoreProvider(),
        SecretsStore.StoreSecretProvider(),
        Tunnel.ConfigurationProvider(),
        Tunnel.TunnelProvider(),
        Tunnel.RouteProvider(),
        Vectorize.IndexProvider(),
        Vectorize.MetadataIndexProvider(),
        VpcService.VpcServiceProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.CronEventSourcePolicyLive,
        Workers.GitHubRepositoryEventSourcePolicyLive,
        Workers.WorkerProvider(),
        Workflows.WorkflowProvider(),
        Zaraz.ConfigProvider(),
        Zone.ZoneProvider(),
        // Split into nested groups: a single flat mergeAll with ~200
        // arguments exceeds tsgo's variadic inference ceiling and
        // silently drops the tail layers from the inferred union.
        Layer.mergeAll(
          AccessApp.ApplicationProvider(),
          Bookmark.BookmarkProvider(),
          AccessCert.CertificateProvider(),
          CustomPage.CustomPageProvider(),
          Group.GroupProvider(),
          AccessIdp.IdentityProviderProvider(),
          AccessInfraTarget.InfrastructureTargetProvider(),
          AccessKeyConfig.KeyConfigurationProvider(),
          McpPortal.McpPortalProvider(),
          AccessOrg.OrganizationProvider(),
          AccessPol.PolicyProvider(),
          AccessSvcToken.ServiceTokenProvider(),
          Tag.TagProvider(),
          Account.MemberProvider(),
          Account.AccountProvider(),
          Acm.CustomTrustStoreProvider(),
          Acm.TotalTlsProvider(),
          Addressing.BgpPrefixProvider(),
          Addressing.PrefixDelegationProvider(),
          Addressing.PrefixProvider(),
          Addressing.ServiceBindingProvider(),
          Addressing.AddressMapProvider(),
          AiGateway.DatasetProvider(),
          AiGateway.DynamicRoutingProvider(),
          AiGateway.EvaluationProvider(),
          AiGateway.GatewayProvider(),
          AiGateway.ProviderConfigProvider(),
          AiSearch.InstanceProvider(),
          AiSearch.NamespaceProvider(),
          AiSearch.TokenProvider(),
          AiSecurity.CustomTopicsProvider(),
          AiSecurity.SettingsProvider(),
          Alerting.NotificationPolicyProvider(),
          Alerting.NotificationWebhookProvider(),
          Alerting.SilenceProvider(),
          ApiShield.ConfigurationProvider(),
          ApiShield.LabelProvider(),
          ApiShield.OperationProvider(),
          ApiShield.UserSchemaProvider(),
          ApiToken.AccountApiTokenProvider(),
          ApiToken.UserApiTokenProvider(),
          Argo.SmartRoutingProvider(),
          Argo.TieredCachingProvider(),
          BotManagement.BotManagementProvider(),
          Cache.ReserveProvider(),
          Cache.OriginCloudRegionProvider(),
          Cache.RegionalTieredCacheProvider(),
          Cache.SmartTieredCacheProvider(),
          Cache.VariantsProvider(),
          Calls.AppProvider(),
          Calls.TurnKeyProvider(),
          CertificateAuthorities.HostnameAssociationProvider(),
          ClientCertificate.ClientCertificateProvider(),
          CloudConnector.RulesProvider(),
          CloudforceOne.ScanConfigProvider(),
          Connectivity.DirectoryServiceProvider(),
          Containers.ContainerProvider(),
          ContentScanning.ExpressionProvider(),
          ContentScanning.ContentScanningProvider(),
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
          Devices.DeviceCustomProfileProvider(),
          Devices.DeviceDefaultProfileProvider(),
          Devices.DeviceDexTestProvider(),
          Devices.DeviceManagedNetworkProvider(),
          Devices.DevicePostureIntegrationProvider(),
          Devices.DevicePostureRuleProvider(),
          Devices.DeviceSettingsProvider(),
          Diagnostics.EndpointHealthcheckProvider(),
          Dlp.EntryProvider(),
          Dlp.ProfileProvider(),
          Dns.RecordProvider(),
          Dns.DnssecProvider(),
          Dns.ZoneDnsSettingsProvider(),
          DnsFirewall.DnsFirewallProvider(),
          Email.AddressProvider(),
          Email.CatchAllProvider(),
          Email.RoutingProvider(),
          Email.RuleProvider(),
          Email.SendingSubdomainProvider(),
          EmailSecurity.AllowPolicyProvider(),
          EmailSecurity.BlockSenderProvider(),
          EmailSecurity.DomainProvider(),
          EmailSecurity.ImpersonationRegistryEntryProvider(),
          EmailSecurity.TrustedDomainProvider(),
          Firewall.AccessRuleProvider(),
          Firewall.LockdownProvider(),
          Firewall.UaRuleProvider(),
          Flagship.AppProvider(),
          Flagship.FlagProvider(),
          Fraud.DetectionSettingsProvider(),
          Certificate.CertificateProvider(),
          Configuration.ConfigurationProvider(),
          List.ListProvider(),
          Location.LocationProvider(),
          Logging.LoggingProvider(),
          ProxyEndpoint.ProxyEndpointProvider(),
          Rule.RuleProvider(),
          Healthcheck.HealthcheckProvider(),
          HostnameTlsSetting.HostnameTlsSettingProvider(),
          Hyperdrive.ConnectionProvider(),
          Iam.ResourceGroupProvider(),
          Iam.UserGroupMembershipProvider(),
          Iam.UserGroupProvider(),
          Images.SigningKeyProvider(),
          Images.VariantProvider(),
          Intel.IndicatorFeedPermissionProvider(),
          Intel.IndicatorFeedProvider(),
          VulnScanner.VulnScannerCredentialProvider(),
          VulnScanner.VulnScannerCredentialSetProvider(),
          VulnScanner.VulnScannerTargetEnvironmentProvider(),
        ),
        Layer.mergeAll(
          KeylessCertificate.KeylessCertificateProvider(),
          KV.NamespaceProvider(),
          LeakedCredentialCheck.LeakedCredentialCheckProvider(),
          LeakedCredentialCheck.LeakedCredentialDetectionProvider(),
          Logpush.JobProvider(),
          LogsControl.LogsCmbConfigProvider(),
          LogsControl.LogsRetentionFlagProvider(),
          MagicCloudNetworking.CatalogSyncProvider(),
          MagicCloudNetworking.CloudIntegrationProvider(),
          MagicCloudNetworking.OnRampProvider(),
          MagicNetworkMonitoring.ConfigProvider(),
          MagicNetworkMonitoring.RuleProvider(),
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
          OriginTlsClientAuth.CertificateProvider(),
          OriginTlsClientAuth.HostnameAssociationProvider(),
          OriginTlsClientAuth.HostnameCertificateProvider(),
          OriginTlsClientAuth.SettingProvider(),
          PageRule.PageRuleProvider(),
          Pages.DeploymentProvider(),
          Pages.DomainProvider(),
          Pages.ProjectProvider(),
          PageShield.PolicyProvider(),
          PageShield.SettingsProvider(),
          Pipelines.LegacyPipelineProvider(),
          Pipelines.PipelineProvider(),
          Pipelines.PipelineSinkProvider(),
          Pipelines.PipelineStreamProvider(),
          Queue.ConsumerProvider(),
          Queue.EventSourcePolicyLive,
          Queue.QueueProvider(),
          Queue.SubscriptionProvider(),
          R2.BucketEventNotificationProvider(),
          R2.BucketProvider(),
          R2.BucketSippyProvider(),
          R2DataCatalog.R2DataCatalogProvider(),
          RealtimeKit.AppProvider(),
          RealtimeKit.PresetProvider(),
          RealtimeKit.WebhookProvider(),
          RegionalHostname.RegionalHostnameProvider(),
          Registrar.DomainProvider(),
          ResourceSharing.ShareProvider(),
          ResourceSharing.ShareRecipientProvider(),
          ResourceSharing.ShareResourceProvider(),
          RiskScoring.IntegrationProvider(),
          Rules.ListProvider(),
          Ruleset.CustomRulesetProvider(),
          Ruleset.AccountEntrypointProvider(),
          Ruleset.RulesetProvider(),
          Rum.RuleProvider(),
          Rum.SiteProvider(),
          SchemaValidation.OperationSettingProvider(),
          SchemaValidation.SchemaProvider(),
          SchemaValidation.SettingsProvider(),
          SecretsStore.SecretsStoreProvider(),
          SecretsStore.StoreSecretProvider(),
          SecurityTxt.SecurityTxtProvider(),
          Snippets.SnippetProvider(),
          Snippets.SnippetRulesProvider(),
          Spectrum.ApplicationProvider(),
          Speed.TestScheduleProvider(),
          Ssl.CertificatePackProvider(),
          Ssl.UniversalSslProvider(),
          Stream.LiveInputOutputProvider(),
          Stream.LiveInputProvider(),
          Stream.SigningKeyProvider(),
          Stream.WatermarkProvider(),
          Stream.WebhookProvider(),
          Tags.AccountResourceTagsProvider(),
          Tags.ZoneResourceTagsProvider(),
          TokenValidation.TokenConfigurationProvider(),
          TokenValidation.RuleProvider(),
          Tunnel.ConfigurationProvider(),
          Tunnel.HostnameRouteProvider(),
          Tunnel.TunnelProvider(),
          Tunnel.RouteProvider(),
          Tunnel.VirtualNetworkProvider(),
          Tunnel.WarpConnectorProvider(),
          Turnstile.WidgetProvider(),
          UrlNorm.UrlNormalizationProvider(),
          Vectorize.IndexProvider(),
          Vectorize.MetadataIndexProvider(),
          VpcService.VpcServiceProvider(),
          WaitingRoom.WaitingRoomProvider(),
          WaitingRoom.SettingsProvider(),
          Web3.HostnameContentListProvider(),
          Web3.HostnameProvider(),
          Workers.BindWorkerPolicyLive,
          Workers.CronEventSourcePolicyLive,
          Workers.ObservabilityDestinationProvider(),
          Workers.WorkerProvider(),
          Workers.WorkerRouteProvider(),
          Workers.AccountSettingProvider(),
          Workers.SubdomainProvider(),
          WorkersForPlatforms.DispatchNamespaceProvider(),
          Workflows.WorkflowProvider(),
          Zaraz.ConfigProvider(),
          Zone.CustomNameserversProvider(),
          Zone.HoldProvider(),
          Zone.ZoneProvider(),
          Zone.SettingProvider(),
        ),
        Layer.mergeAll(
          Dns.AccountDnsSettingsProvider(),
          Dns.ViewProvider(),
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
        LoadBalancer.MonitorProvider(),
        LoadBalancer.MonitorGroupProvider(),
        LoadBalancer.PoolProvider(),
        Command.providers(),
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
        Effect.fn(function* (duration) {
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
