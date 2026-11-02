import { DockerLive } from "@alchemy.run/docker/Docker";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "alchemy/Website/Server";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
// ── ALB imports ──
import {
  LoadBalancer as AlbLoadBalancer,
  LoadBalancerProvider as AlbLoadBalancerProvider,
} from "./ALB/LoadBalancer.ts";
import {
  ObservabilityCredential as AlbObservabilityCredential,
  ObservabilityCredentialProvider as AlbObservabilityCredentialProvider,
} from "./ALB/ObservabilityCredential.ts";
import { StackitAuth } from "./AuthProvider.ts";
// ── Automation imports ──
import { VolumeAutomation, VolumeAutomationProvider } from "./Automation/VolumeAutomation.ts";
// ── CDN imports ──
import { CustomDomain, CustomDomainProvider } from "./CDN/CustomDomain.ts";
import { Distribution, DistributionProvider } from "./CDN/Distribution.ts";
// ── Certificates imports ──
import { Certificate, CertificateProvider } from "./Certificates/Certificate.ts";
// ── CloudFoundry imports ──
import {
  App as CloudFoundryApp,
  AppProvider as CloudFoundryAppProvider,
} from "./CloudFoundry/App.ts";
import {
  Organization as CloudFoundryOrganization,
  OrganizationProvider as CloudFoundryOrganizationProvider,
} from "./CloudFoundry/Organization.ts";
import {
  OrganizationManager as CloudFoundryOrganizationManager,
  OrganizationManagerProvider as CloudFoundryOrganizationManagerProvider,
} from "./CloudFoundry/OrganizationManager.ts";
import {
  OrganizationRole as CloudFoundryOrganizationRole,
  OrganizationRoleProvider as CloudFoundryOrganizationRoleProvider,
} from "./CloudFoundry/OrganizationRole.ts";
import {
  Route as CloudFoundryRoute,
  RouteProvider as CloudFoundryRouteProvider,
} from "./CloudFoundry/Route.ts";
import {
  ServiceInstance as CloudFoundryServiceInstance,
  ServiceInstanceProvider as CloudFoundryServiceInstanceProvider,
} from "./CloudFoundry/ServiceInstance.ts";
import {
  Space as CloudFoundrySpace,
  SpaceProvider as CloudFoundrySpaceProvider,
} from "./CloudFoundry/Space.ts";
import {
  SpaceRole as CloudFoundrySpaceRole,
  SpaceRoleProvider as CloudFoundrySpaceRoleProvider,
} from "./CloudFoundry/SpaceRole.ts";
// ── ContainerApplications imports ──
import {
  Application as ContainerApplicationsApplication,
  ApplicationProvider as ContainerApplicationsApplicationProvider,
} from "./ContainerApplications/Application.ts";
import {
  Environment as ContainerApplicationsEnvironment,
  EnvironmentProvider as ContainerApplicationsEnvironmentProvider,
} from "./ContainerApplications/Environment.ts";
import {
  EnvironmentRegistry as ContainerApplicationsEnvironmentRegistry,
  EnvironmentRegistryProvider as ContainerApplicationsEnvironmentRegistryProvider,
} from "./ContainerApplications/EnvironmentRegistry.ts";
import {
  EnvironmentSecret as ContainerApplicationsEnvironmentSecret,
  EnvironmentSecretProvider as ContainerApplicationsEnvironmentSecretProvider,
} from "./ContainerApplications/EnvironmentSecret.ts";
// ── ContainerRegistry imports ──
import {
  Project as ContainerRegistryProject,
  ProjectProvider as ContainerRegistryProjectProvider,
} from "./ContainerRegistry/Project.ts";
import { RobotAccount, RobotAccountProvider } from "./ContainerRegistry/RobotAccount.ts";
import * as Credentials from "./Credentials.ts";
// ── DNS imports ──
import { RecordSet, RecordSetProvider } from "./DNS/RecordSet.ts";
import { Zone, ZoneProvider } from "./DNS/Zone.ts";
// ── Dremio imports ──
import {
  Instance as DremioInstance,
  InstanceProvider as DremioInstanceProvider,
} from "./Dremio/Instance.ts";
import { User as DremioUser, UserProvider as DremioUserProvider } from "./Dremio/User.ts";
// ── EdgeCloud imports ──
import {
  Instance as EdgeCloudInstance,
  InstanceProvider as EdgeCloudInstanceProvider,
} from "./EdgeCloud/Instance.ts";
import {
  Kubeconfig as EdgeCloudKubeconfig,
  KubeconfigProvider as EdgeCloudKubeconfigProvider,
} from "./EdgeCloud/Kubeconfig.ts";
import {
  Token as EdgeCloudToken,
  TokenProvider as EdgeCloudTokenProvider,
} from "./EdgeCloud/Token.ts";
import { environmentFromAuthProvider } from "./Environment.ts";
// ── FileStorage imports ──
import { ProjectLock, ProjectLockProvider } from "./FileStorage/ProjectLock.ts";
import { ResourcePool, ResourcePoolProvider } from "./FileStorage/ResourcePool.ts";
import {
  ResourcePoolSnapshot,
  ResourcePoolSnapshotProvider,
} from "./FileStorage/ResourcePoolSnapshot.ts";
import { Share, ShareProvider } from "./FileStorage/Share.ts";
import { ShareExportPolicy, ShareExportPolicyProvider } from "./FileStorage/ShareExportPolicy.ts";
// ── Functions imports ──
import { Function as FunctionsFunction, FunctionProvider } from "./Functions/Function.ts";
import { PullCredential, PullCredentialProvider } from "./Functions/PullCredential.ts";
// ── Git imports ──
import {
  AuthenticationSource as GitAuthenticationSource,
  AuthenticationSourceProvider as GitAuthenticationSourceProvider,
} from "./Git/AuthenticationSource.ts";
import {
  Instance as GitInstance,
  InstanceProvider as GitInstanceProvider,
} from "./Git/Instance.ts";
import {
  Repository as GitRepository,
  RepositoryProvider as GitRepositoryProvider,
} from "./Git/Repository.ts";
import { Runner as GitRunner, RunnerProvider as GitRunnerProvider } from "./Git/Runner.ts";
import { User as GitUser, UserProvider as GitUserProvider } from "./Git/User.ts";
// ── IaaS imports ──
import { AffinityGroup, AffinityGroupProvider } from "./IaaS/AffinityGroup.ts";
import { Backup, BackupProvider } from "./IaaS/Backup.ts";
import { Image, ImageProvider } from "./IaaS/Image.ts";
import { ImageShare, ImageShareProvider } from "./IaaS/ImageShare.ts";
import { KeyPair, KeyPairProvider } from "./IaaS/KeyPair.ts";
import { Network, NetworkProvider } from "./IaaS/Network.ts";
import { NetworkArea, NetworkAreaProvider } from "./IaaS/NetworkArea.ts";
import { NetworkAreaRegion, NetworkAreaRegionProvider } from "./IaaS/NetworkAreaRegion.ts";
import { NetworkAreaRoute, NetworkAreaRouteProvider } from "./IaaS/NetworkAreaRoute.ts";
import { NetworkInterface, NetworkInterfaceProvider } from "./IaaS/NetworkInterface.ts";
import { PublicIp, PublicIpProvider } from "./IaaS/PublicIp.ts";
import { RoutingTable, RoutingTableProvider } from "./IaaS/RoutingTable.ts";
import { RoutingTableRoute, RoutingTableRouteProvider } from "./IaaS/RoutingTableRoute.ts";
import { SecurityGroup, SecurityGroupProvider } from "./IaaS/SecurityGroup.ts";
import { SecurityGroupRule, SecurityGroupRuleProvider } from "./IaaS/SecurityGroupRule.ts";
import { Server, ServerProvider } from "./IaaS/Server.ts";
import {
  ServerNetworkInterfaceAttachment,
  ServerNetworkInterfaceAttachmentProvider,
} from "./IaaS/ServerNetworkInterfaceAttachment.ts";
import {
  ServerSecurityGroupAttachment,
  ServerSecurityGroupAttachmentProvider,
} from "./IaaS/ServerSecurityGroupAttachment.ts";
import {
  ServerServiceAccountAttachment,
  ServerServiceAccountAttachmentProvider,
} from "./IaaS/ServerServiceAccountAttachment.ts";
import { Service as IaaSService, ServiceProvider as IaaSServiceProvider } from "./IaaS/Service.ts";
import { Snapshot, SnapshotProvider } from "./IaaS/Snapshot.ts";
import { Volume, VolumeProvider } from "./IaaS/Volume.ts";
import { VolumeAttachment, VolumeAttachmentProvider } from "./IaaS/VolumeAttachment.ts";
// ── IAM imports ──
import { CustomRole, CustomRoleProvider } from "./IAM/CustomRole.ts";
import {
  FederatedIdentityProvider,
  FederatedIdentityProviderProvider,
} from "./IAM/FederatedIdentityProvider.ts";
import { Membership, MembershipProvider } from "./IAM/Membership.ts";
import { ServiceAccount, ServiceAccountProvider } from "./IAM/ServiceAccount.ts";
import { ServiceAccountKey, ServiceAccountKeyProvider } from "./IAM/ServiceAccountKey.ts";
// ── Intake imports ──
import { Intake as IntakeIntake, IntakeProvider as IntakeIntakeProvider } from "./Intake/Intake.ts";
import { Runner as IntakeRunner, RunnerProvider as IntakeRunnerProvider } from "./Intake/Runner.ts";
import { User as IntakeUser, UserProvider as IntakeUserProvider } from "./Intake/User.ts";
// ── IPLists imports ──
import { IPList, IPListProvider } from "./IPLists/IPList.ts";
// ── KMS imports ──
import { Key, KeyProvider } from "./KMS/Key.ts";
import { KeyRing, KeyRingProvider } from "./KMS/KeyRing.ts";
import { WrappingKey, WrappingKeyProvider } from "./KMS/WrappingKey.ts";
// ── LoadBalancer imports ──
import {
  LoadBalancer as NlbLoadBalancer,
  LoadBalancerProvider as NlbLoadBalancerProvider,
} from "./LoadBalancer/LoadBalancer.ts";
import {
  ObservabilityCredential as NlbObservabilityCredential,
  ObservabilityCredentialProvider as NlbObservabilityCredentialProvider,
} from "./LoadBalancer/ObservabilityCredential.ts";
// ── LogMe imports ──
import {
  Credential as LogMeCredential,
  CredentialProvider as LogMeCredentialProvider,
} from "./LogMe/Credential.ts";
import {
  Instance as LogMeInstance,
  InstanceProvider as LogMeInstanceProvider,
} from "./LogMe/Instance.ts";
// ── Logs imports ──
import {
  AccessPolicy as LogsAccessPolicy,
  AccessPolicyProvider as LogsAccessPolicyProvider,
} from "./Logs/AccessPolicy.ts";
import {
  AccessToken as LogsAccessToken,
  AccessTokenProvider as LogsAccessTokenProvider,
} from "./Logs/AccessToken.ts";
import {
  Instance as LogsInstance,
  InstanceProvider as LogsInstanceProvider,
} from "./Logs/Instance.ts";
// ── MariaDB imports ──
import {
  Credential as MariaDBCredential,
  CredentialProvider as MariaDBCredentialProvider,
} from "./MariaDB/Credential.ts";
import {
  Instance as MariaDBInstance,
  InstanceProvider as MariaDBInstanceProvider,
} from "./MariaDB/Instance.ts";
// ── ModelExperiments imports ──
import {
  Instance as ModelExperimentsInstance,
  InstanceProvider as ModelExperimentsInstanceProvider,
} from "./ModelExperiments/Instance.ts";
import {
  Token as ModelExperimentsToken,
  TokenProvider as ModelExperimentsTokenProvider,
} from "./ModelExperiments/Token.ts";
// ── ModelServing imports ──
import {
  Token as ModelServingToken,
  TokenProvider as ModelServingTokenProvider,
} from "./ModelServing/Token.ts";
// ── MongoDBFlex imports ──
import {
  Instance as MongoDBFlexInstance,
  InstanceProvider as MongoDBFlexInstanceProvider,
} from "./MongoDBFlex/Instance.ts";
import {
  User as MongoDBFlexUser,
  UserProvider as MongoDBFlexUserProvider,
} from "./MongoDBFlex/User.ts";
// ── ObjectStorage imports ──
import { AccessKey, AccessKeyProvider } from "./ObjectStorage/AccessKey.ts";
import { Bucket, BucketProvider } from "./ObjectStorage/Bucket.ts";
import { ComplianceLock, ComplianceLockProvider } from "./ObjectStorage/ComplianceLock.ts";
import { CredentialsGroup, CredentialsGroupProvider } from "./ObjectStorage/CredentialsGroup.ts";
import {
  Project as ObjectStorageProject,
  ProjectProvider as ObjectStorageProjectProvider,
} from "./ObjectStorage/Project.ts";
// ── Observability imports ──
import {
  AlertConfig as ObservabilityAlertConfig,
  AlertConfigProvider as ObservabilityAlertConfigProvider,
} from "./Observability/AlertConfig.ts";
import {
  AlertGroup as ObservabilityAlertGroup,
  AlertGroupProvider as ObservabilityAlertGroupProvider,
} from "./Observability/AlertGroup.ts";
import {
  AlertWebhook as ObservabilityAlertWebhook,
  AlertWebhookProvider as ObservabilityAlertWebhookProvider,
} from "./Observability/AlertWebhook.ts";
import {
  CertCheck as ObservabilityCertCheck,
  CertCheckProvider as ObservabilityCertCheckProvider,
} from "./Observability/CertCheck.ts";
import {
  Credential as ObservabilityCredential,
  CredentialProvider as ObservabilityCredentialProvider,
} from "./Observability/Credential.ts";
import {
  ElasticsearchCheck as ObservabilityElasticsearchCheck,
  ElasticsearchCheckProvider as ObservabilityElasticsearchCheckProvider,
} from "./Observability/ElasticsearchCheck.ts";
import {
  HttpCheck as ObservabilityHttpCheck,
  HttpCheckProvider as ObservabilityHttpCheckProvider,
} from "./Observability/HttpCheck.ts";
import {
  Instance as ObservabilityInstance,
  InstanceProvider as ObservabilityInstanceProvider,
} from "./Observability/Instance.ts";
import {
  LogsAlertGroup as ObservabilityLogsAlertGroup,
  LogsAlertGroupProvider as ObservabilityLogsAlertGroupProvider,
} from "./Observability/LogsAlertGroup.ts";
import {
  MongoDBCheck as ObservabilityMongoDBCheck,
  MongoDBCheckProvider as ObservabilityMongoDBCheckProvider,
} from "./Observability/MongoDBCheck.ts";
import {
  MySQLCheck as ObservabilityMySQLCheck,
  MySQLCheckProvider as ObservabilityMySQLCheckProvider,
} from "./Observability/MySQLCheck.ts";
import {
  NetworkCheck as ObservabilityNetworkCheck,
  NetworkCheckProvider as ObservabilityNetworkCheckProvider,
} from "./Observability/NetworkCheck.ts";
import {
  PingCheck as ObservabilityPingCheck,
  PingCheckProvider as ObservabilityPingCheckProvider,
} from "./Observability/PingCheck.ts";
import {
  PostgreSQLCheck as ObservabilityPostgreSQLCheck,
  PostgreSQLCheckProvider as ObservabilityPostgreSQLCheckProvider,
} from "./Observability/PostgreSQLCheck.ts";
import {
  RabbitMQCheck as ObservabilityRabbitMQCheck,
  RabbitMQCheckProvider as ObservabilityRabbitMQCheckProvider,
} from "./Observability/RabbitMQCheck.ts";
import {
  RedisCheck as ObservabilityRedisCheck,
  RedisCheckProvider as ObservabilityRedisCheckProvider,
} from "./Observability/RedisCheck.ts";
import {
  ScrapeConfig as ObservabilityScrapeConfig,
  ScrapeConfigProvider as ObservabilityScrapeConfigProvider,
} from "./Observability/ScrapeConfig.ts";
// ── OpenSearch imports ──
import {
  Credential as OpenSearchCredential,
  CredentialProvider as OpenSearchCredentialProvider,
} from "./OpenSearch/Credential.ts";
import {
  Instance as OpenSearchInstance,
  InstanceProvider as OpenSearchInstanceProvider,
} from "./OpenSearch/Instance.ts";
// ── PostgresFlex imports ──
import {
  Database as PostgresFlexDatabase,
  DatabaseProvider as PostgresFlexDatabaseProvider,
} from "./PostgresFlex/Database.ts";
import {
  Instance as PostgresFlexInstance,
  InstanceProvider as PostgresFlexInstanceProvider,
} from "./PostgresFlex/Instance.ts";
import {
  User as PostgresFlexUser,
  UserProvider as PostgresFlexUserProvider,
} from "./PostgresFlex/User.ts";
// ── PubSub imports ──
import {
  Subscription as PubSubSubscription,
  SubscriptionProvider as PubSubSubscriptionProvider,
} from "./PubSub/Subscription.ts";
import {
  SubscriptionSubscriberAccess as PubSubSubscriptionSubscriberAccess,
  SubscriptionSubscriberAccessProvider as PubSubSubscriptionSubscriberAccessProvider,
} from "./PubSub/SubscriptionSubscriberAccess.ts";
import { Topic as PubSubTopic, TopicProvider as PubSubTopicProvider } from "./PubSub/Topic.ts";
import {
  TopicPublisherAccess as PubSubTopicPublisherAccess,
  TopicPublisherAccessProvider as PubSubTopicPublisherAccessProvider,
} from "./PubSub/TopicPublisherAccess.ts";
// ── RabbitMQ imports ──
import {
  Credential as RabbitMQCredential,
  CredentialProvider as RabbitMQCredentialProvider,
} from "./RabbitMQ/Credential.ts";
import {
  Instance as RabbitMQInstance,
  InstanceProvider as RabbitMQInstanceProvider,
} from "./RabbitMQ/Instance.ts";
// ── ResourceManager imports ──
import { Folder, FolderProvider } from "./ResourceManager/Folder.ts";
import { Organization, OrganizationProvider } from "./ResourceManager/Organization.ts";
import { Project, ProjectProvider } from "./ResourceManager/Project.ts";
// ── SecretsManager imports ──
import {
  AppRole as SecretsManagerAppRole,
  AppRoleProvider as SecretsManagerAppRoleProvider,
} from "./SecretsManager/AppRole.ts";
import {
  AppRoleSecretId as SecretsManagerAppRoleSecretId,
  AppRoleSecretIdProvider as SecretsManagerAppRoleSecretIdProvider,
} from "./SecretsManager/AppRoleSecretId.ts";
import {
  Instance as SecretsManagerInstance,
  InstanceProvider as SecretsManagerInstanceProvider,
} from "./SecretsManager/Instance.ts";
import {
  Secret as SecretsManagerSecret,
  SecretProvider as SecretsManagerSecretProvider,
} from "./SecretsManager/Secret.ts";
import {
  User as SecretsManagerUser,
  UserProvider as SecretsManagerUserProvider,
} from "./SecretsManager/User.ts";
// ── ServerBackup imports ──
import {
  Backup as ServerBackupBackup,
  BackupProvider as ServerBackupBackupProvider,
} from "./ServerBackup/Backup.ts";
import {
  Enablement as ServerBackupEnablement,
  EnablementProvider as ServerBackupEnablementProvider,
} from "./ServerBackup/Enablement.ts";
import {
  Schedule as ServerBackupSchedule,
  ScheduleProvider as ServerBackupScheduleProvider,
} from "./ServerBackup/Schedule.ts";
// ── ServerUpdate imports ──
import {
  Enablement as ServerUpdateEnablement,
  EnablementProvider as ServerUpdateEnablementProvider,
} from "./ServerUpdate/Enablement.ts";
import {
  Schedule as ServerUpdateSchedule,
  ScheduleProvider as ServerUpdateScheduleProvider,
} from "./ServerUpdate/Schedule.ts";
// ── ServiceEnablement imports ──
import { Service, ServiceProvider } from "./ServiceEnablement/Service.ts";
// ── SKE imports ──
import { Cluster, ClusterProvider } from "./SKE/Cluster.ts";
import { Kubeconfig, KubeconfigProvider } from "./SKE/Kubeconfig.ts";
import { SkeKubernetesAdapter } from "./SKE/KubernetesAdapter.ts";
// ── SQLServerFlex imports ──
import {
  Database as SqlServerFlexDatabase,
  DatabaseProvider as SqlServerFlexDatabaseProvider,
} from "./SQLServerFlex/Database.ts";
import {
  Instance as SqlServerFlexInstance,
  InstanceProvider as SqlServerFlexInstanceProvider,
} from "./SQLServerFlex/Instance.ts";
import {
  User as SqlServerFlexUser,
  UserProvider as SqlServerFlexUserProvider,
} from "./SQLServerFlex/User.ts";
// ── Telemetry Router imports ──
import {
  AccessToken as TelemetryAccessToken,
  AccessTokenProvider as TelemetryAccessTokenProvider,
} from "./Telemetry/AccessToken.ts";
import {
  Destination as TelemetryDestination,
  DestinationProvider as TelemetryDestinationProvider,
} from "./Telemetry/Destination.ts";
import { Link as TelemetryLink, LinkProvider as TelemetryLinkProvider } from "./Telemetry/Link.ts";
import {
  Router as TelemetryRouter,
  RouterProvider as TelemetryRouterProvider,
} from "./Telemetry/Router.ts";
// ── UnifiedFirewall imports ──
import {
  Rule as UnifiedFirewallRule,
  RuleProvider as UnifiedFirewallRuleProvider,
} from "./UnifiedFirewall/Rule.ts";
// ── Valkey imports ──
import {
  Credential as ValkeyCredential,
  CredentialProvider as ValkeyCredentialProvider,
} from "./Valkey/Credential.ts";
import {
  Instance as ValkeyInstance,
  InstanceProvider as ValkeyInstanceProvider,
} from "./Valkey/Instance.ts";
// ── VPN imports ──
import {
  BGPFilter as VpnBGPFilter,
  BGPFilterProvider as VpnBGPFilterProvider,
} from "./VPN/BGPFilter.ts";
import {
  BGPFilterRule as VpnBGPFilterRule,
  BGPFilterRuleProvider as VpnBGPFilterRuleProvider,
} from "./VPN/BGPFilterRule.ts";
import {
  Connection as VpnConnection,
  ConnectionProvider as VpnConnectionProvider,
} from "./VPN/Connection.ts";
import { Gateway as VpnGateway, GatewayProvider as VpnGatewayProvider } from "./VPN/Gateway.ts";
// ── WAF imports ──
import {
  Configuration as WafConfiguration,
  ConfigurationProvider as WafConfigurationProvider,
} from "./WAF/Configuration.ts";
import {
  CustomRuleGroup as WafCustomRuleGroup,
  CustomRuleGroupProvider as WafCustomRuleGroupProvider,
} from "./WAF/CustomRuleGroup.ts";
import {
  ManagedRuleSet as WafManagedRuleSet,
  ManagedRuleSetProvider as WafManagedRuleSetProvider,
} from "./WAF/ManagedRuleSet.ts";
// ── Website imports ──
import { AssetDeployment, AssetDeploymentProvider } from "./Website/AssetDeployment.ts";
import { CachePurge, CachePurgeProvider } from "./Website/CachePurge.ts";
import { ServerImage, ServerImageProvider } from "./Website/ServerImage.ts";
// ── Workflows imports ──
import {
  Instance as WorkflowsInstance,
  InstanceProvider as WorkflowsInstanceProvider,
} from "./Workflows/Instance.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Stackit") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/*
 * Registration: each namespace owns one resource list and one provider
 * group below. Add a resource class to its namespace's `*Resources` array
 * and its `*Provider()` layer to the matching `*Providers` group — single
 * line insertions, alphabetical within a group. Keep each group under ~90
 * entries (split into nested `Layer.mergeAll` calls beyond that): a flat
 * ~200-argument call exceeds tsc's variadic inference and silently drops
 * the tail layers from the inferred union. `Layer.empty` keeps an empty
 * group valid; leave it in place.
 */

const serviceEnablementResources = [Service];
const serviceEnablementProviders = () => Layer.mergeAll(Layer.empty, ServiceProvider());

// Replace `[] as const` with `[A, B]` when adding the first resource.
const resourceManagerResources = [Folder, Organization, Project];
const resourceManagerProviders = () =>
  Layer.mergeAll(Layer.empty, FolderProvider(), OrganizationProvider(), ProjectProvider());

const iamResources = [
  CustomRole,
  FederatedIdentityProvider,
  Membership,
  ServiceAccount,
  ServiceAccountKey,
];
const iamProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    CustomRoleProvider(),
    FederatedIdentityProviderProvider(),
    MembershipProvider(),
    ServiceAccountProvider(),
    ServiceAccountKeyProvider(),
  );

const iaasResources = [
  AffinityGroup,
  Backup,
  Image,
  ImageShare,
  KeyPair,
  Server,
  ServerNetworkInterfaceAttachment,
  ServerSecurityGroupAttachment,
  ServerServiceAccountAttachment,
  IaaSService,
  Snapshot,
  Volume,
  VolumeAttachment,
  Network,
  NetworkArea,
  NetworkAreaRegion,
  NetworkAreaRoute,
  NetworkInterface,
  PublicIp,
  RoutingTable,
  RoutingTableRoute,
  SecurityGroup,
  SecurityGroupRule,
];
const iaasProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    AffinityGroupProvider(),
    BackupProvider(),
    ImageProvider(),
    ImageShareProvider(),
    KeyPairProvider(),
    ServerProvider(),
    ServerNetworkInterfaceAttachmentProvider(),
    ServerSecurityGroupAttachmentProvider(),
    ServerServiceAccountAttachmentProvider(),
    IaaSServiceProvider(),
    SnapshotProvider(),
    VolumeProvider(),
    VolumeAttachmentProvider(),
    NetworkProvider(),
    NetworkAreaProvider(),
    NetworkAreaRegionProvider(),
    NetworkAreaRouteProvider(),
    NetworkInterfaceProvider(),
    PublicIpProvider(),
    RoutingTableProvider(),
    RoutingTableRouteProvider(),
    SecurityGroupProvider(),
    SecurityGroupRuleProvider(),
  );

const functionsResources = [FunctionsFunction, PullCredential];
const functionsProviders = () =>
  Layer.mergeAll(Layer.empty, FunctionProvider(), PullCredentialProvider());

const skeResources = [Cluster, Kubeconfig];
const skeProviders = () => Layer.mergeAll(Layer.empty, ClusterProvider(), KubeconfigProvider());

const containerApplicationsResources = [
  ContainerApplicationsApplication,
  ContainerApplicationsEnvironment,
  ContainerApplicationsEnvironmentRegistry,
  ContainerApplicationsEnvironmentSecret,
];
const containerApplicationsProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    ContainerApplicationsApplicationProvider(),
    ContainerApplicationsEnvironmentProvider(),
    ContainerApplicationsEnvironmentRegistryProvider(),
    ContainerApplicationsEnvironmentSecretProvider(),
  );

const containerRegistryResources = [ContainerRegistryProject, RobotAccount];
const containerRegistryProviders = () =>
  Layer.mergeAll(Layer.empty, ContainerRegistryProjectProvider(), RobotAccountProvider());

const dnsResources = [RecordSet, Zone];
const dnsProviders = () => Layer.mergeAll(Layer.empty, RecordSetProvider(), ZoneProvider());

const objectStorageResources = [
  AccessKey,
  Bucket,
  ComplianceLock,
  CredentialsGroup,
  ObjectStorageProject,
];
const objectStorageProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    AccessKeyProvider(),
    BucketProvider(),
    ComplianceLockProvider(),
    CredentialsGroupProvider(),
    ObjectStorageProjectProvider(),
  );

const loadBalancerResources = [NlbLoadBalancer, NlbObservabilityCredential];
const loadBalancerProviders = () =>
  Layer.mergeAll(Layer.empty, NlbLoadBalancerProvider(), NlbObservabilityCredentialProvider());

const postgresFlexResources = [PostgresFlexDatabase, PostgresFlexInstance, PostgresFlexUser];
const postgresFlexProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    PostgresFlexDatabaseProvider(),
    PostgresFlexInstanceProvider(),
    PostgresFlexUserProvider(),
  );

const sqlServerFlexResources = [SqlServerFlexDatabase, SqlServerFlexInstance, SqlServerFlexUser];
const sqlServerFlexProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    SqlServerFlexDatabaseProvider(),
    SqlServerFlexInstanceProvider(),
    SqlServerFlexUserProvider(),
  );

const mongoDBFlexResources = [MongoDBFlexInstance, MongoDBFlexUser];
const mongoDBFlexProviders = () =>
  Layer.mergeAll(Layer.empty, MongoDBFlexInstanceProvider(), MongoDBFlexUserProvider());

const mariaDBResources = [MariaDBCredential, MariaDBInstance];
const mariaDBProviders = () =>
  Layer.mergeAll(Layer.empty, MariaDBCredentialProvider(), MariaDBInstanceProvider());

const valkeyResources = [ValkeyCredential, ValkeyInstance];
const valkeyProviders = () =>
  Layer.mergeAll(Layer.empty, ValkeyCredentialProvider(), ValkeyInstanceProvider());

const kmsResources = [Key, KeyRing, WrappingKey];
const kmsProviders = () =>
  Layer.mergeAll(Layer.empty, KeyProvider(), KeyRingProvider(), WrappingKeyProvider());

const secretsManagerResources = [
  SecretsManagerAppRole,
  SecretsManagerAppRoleSecretId,
  SecretsManagerInstance,
  SecretsManagerSecret,
  SecretsManagerUser,
];
const secretsManagerProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    SecretsManagerAppRoleProvider(),
    SecretsManagerAppRoleSecretIdProvider(),
    SecretsManagerInstanceProvider(),
    SecretsManagerSecretProvider(),
    SecretsManagerUserProvider(),
  );

const albResources = [AlbLoadBalancer, AlbObservabilityCredential];
const albProviders = () =>
  Layer.mergeAll(Layer.empty, AlbLoadBalancerProvider(), AlbObservabilityCredentialProvider());

const wafResources = [WafConfiguration, WafCustomRuleGroup, WafManagedRuleSet];
const wafProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    WafConfigurationProvider(),
    WafCustomRuleGroupProvider(),
    WafManagedRuleSetProvider(),
  );

const serverBackupResources = [ServerBackupBackup, ServerBackupEnablement, ServerBackupSchedule];
const serverBackupProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    ServerBackupBackupProvider(),
    ServerBackupEnablementProvider(),
    ServerBackupScheduleProvider(),
  );

const serverUpdateResources = [ServerUpdateEnablement, ServerUpdateSchedule];
const serverUpdateProviders = () =>
  Layer.mergeAll(Layer.empty, ServerUpdateEnablementProvider(), ServerUpdateScheduleProvider());

const vpnResources = [VpnGateway, VpnConnection, VpnBGPFilter, VpnBGPFilterRule];
const vpnProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    VpnGatewayProvider(),
    VpnConnectionProvider(),
    VpnBGPFilterProvider(),
    VpnBGPFilterRuleProvider(),
  );

const automationResources = [VolumeAutomation];
const automationProviders = () => Layer.mergeAll(Layer.empty, VolumeAutomationProvider());

const unifiedFirewallResources = [UnifiedFirewallRule];
const unifiedFirewallProviders = () => Layer.mergeAll(Layer.empty, UnifiedFirewallRuleProvider());

const ipListsResources = [IPList];
const ipListsProviders = () => Layer.mergeAll(Layer.empty, IPListProvider());

const cdnResources = [CustomDomain, Distribution];
const cdnProviders = () =>
  Layer.mergeAll(Layer.empty, CustomDomainProvider(), DistributionProvider());

const certificatesResources = [Certificate];
const certificatesProviders = () => Layer.mergeAll(Layer.empty, CertificateProvider());

const pubsubResources = [
  PubSubTopic,
  PubSubSubscription,
  PubSubTopicPublisherAccess,
  PubSubSubscriptionSubscriberAccess,
];
const pubsubProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    PubSubTopicProvider(),
    PubSubSubscriptionProvider(),
    PubSubTopicPublisherAccessProvider(),
    PubSubSubscriptionSubscriberAccessProvider(),
  );

const observabilityResources = [
  ObservabilityAlertConfig,
  ObservabilityAlertGroup,
  ObservabilityAlertWebhook,
  ObservabilityCertCheck,
  ObservabilityCredential,
  ObservabilityElasticsearchCheck,
  ObservabilityHttpCheck,
  ObservabilityInstance,
  ObservabilityLogsAlertGroup,
  ObservabilityMongoDBCheck,
  ObservabilityMySQLCheck,
  ObservabilityNetworkCheck,
  ObservabilityPingCheck,
  ObservabilityPostgreSQLCheck,
  ObservabilityRabbitMQCheck,
  ObservabilityRedisCheck,
  ObservabilityScrapeConfig,
];
const observabilityProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    ObservabilityAlertConfigProvider(),
    ObservabilityAlertGroupProvider(),
    ObservabilityAlertWebhookProvider(),
    ObservabilityCertCheckProvider(),
    ObservabilityCredentialProvider(),
    ObservabilityElasticsearchCheckProvider(),
    ObservabilityHttpCheckProvider(),
    ObservabilityInstanceProvider(),
    ObservabilityLogsAlertGroupProvider(),
    ObservabilityMongoDBCheckProvider(),
    ObservabilityMySQLCheckProvider(),
    ObservabilityNetworkCheckProvider(),
    ObservabilityPingCheckProvider(),
    ObservabilityPostgreSQLCheckProvider(),
    ObservabilityRabbitMQCheckProvider(),
    ObservabilityRedisCheckProvider(),
    ObservabilityScrapeConfigProvider(),
  );

const rabbitmqResources = [RabbitMQCredential, RabbitMQInstance];
const rabbitmqProviders = () =>
  Layer.mergeAll(Layer.empty, RabbitMQCredentialProvider(), RabbitMQInstanceProvider());

const intakeResources = [IntakeRunner, IntakeIntake, IntakeUser];
const intakeProviders = () =>
  Layer.mergeAll(Layer.empty, IntakeRunnerProvider(), IntakeIntakeProvider(), IntakeUserProvider());

const telemetryRouterResources = [TelemetryRouter, TelemetryDestination, TelemetryAccessToken];
const telemetryRouterProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    TelemetryRouterProvider(),
    TelemetryDestinationProvider(),
    TelemetryAccessTokenProvider(),
  );

const dremioResources = [DremioInstance, DremioUser];
const dremioProviders = () =>
  Layer.mergeAll(Layer.empty, DremioInstanceProvider(), DremioUserProvider());

const openSearchResources = [OpenSearchInstance, OpenSearchCredential];
const openSearchProviders = () =>
  Layer.mergeAll(Layer.empty, OpenSearchInstanceProvider(), OpenSearchCredentialProvider());

const logMeResources = [LogMeInstance, LogMeCredential];
const logMeProviders = () =>
  Layer.mergeAll(Layer.empty, LogMeInstanceProvider(), LogMeCredentialProvider());

const modelServingResources = [ModelServingToken];
const modelServingProviders = () => Layer.mergeAll(Layer.empty, ModelServingTokenProvider());

const modelExperimentsResources = [ModelExperimentsInstance, ModelExperimentsToken];
const modelExperimentsProviders = () =>
  Layer.mergeAll(Layer.empty, ModelExperimentsInstanceProvider(), ModelExperimentsTokenProvider());

const logsResources = [LogsAccessPolicy, LogsAccessToken, LogsInstance];
const logsProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    LogsAccessPolicyProvider(),
    LogsAccessTokenProvider(),
    LogsInstanceProvider(),
  );

const cloudFoundryResources = [
  CloudFoundryApp,
  CloudFoundryOrganization,
  CloudFoundryOrganizationManager,
  CloudFoundryOrganizationRole,
  CloudFoundryRoute,
  CloudFoundryServiceInstance,
  CloudFoundrySpace,
  CloudFoundrySpaceRole,
];
const cloudFoundryProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    CloudFoundryAppProvider(),
    CloudFoundryOrganizationManagerProvider(),
    CloudFoundryOrganizationProvider(),
    CloudFoundryOrganizationRoleProvider(),
    CloudFoundryRouteProvider(),
    CloudFoundryServiceInstanceProvider(),
    CloudFoundrySpaceProvider(),
    CloudFoundrySpaceRoleProvider(),
  );

const workflowsResources = [WorkflowsInstance];
const workflowsProviders = () => Layer.mergeAll(Layer.empty, WorkflowsInstanceProvider());

const telemetryLinkResources = [TelemetryLink];
const telemetryLinkProviders = () => Layer.mergeAll(Layer.empty, TelemetryLinkProvider());

const websiteResources = [AssetDeployment, CachePurge, ServerImage, WebsiteServer];
const websiteProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    AssetDeploymentProvider(),
    CachePurgeProvider(),
    ServerImageProvider(),
    WebsiteServerProvider(),
  );

const gitResources = [GitAuthenticationSource, GitInstance, GitRepository, GitRunner, GitUser];
const gitProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    GitAuthenticationSourceProvider(),
    GitInstanceProvider(),
    GitRepositoryProvider(),
    GitRunnerProvider(),
    GitUserProvider(),
  );

const fileStorageResources = [
  ProjectLock,
  ResourcePool,
  ResourcePoolSnapshot,
  Share,
  ShareExportPolicy,
];
const fileStorageProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    ProjectLockProvider(),
    ResourcePoolProvider(),
    ResourcePoolSnapshotProvider(),
    ShareProvider(),
    ShareExportPolicyProvider(),
  );

const edgeCloudResources = [EdgeCloudInstance, EdgeCloudKubeconfig, EdgeCloudToken];
const edgeCloudProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    EdgeCloudInstanceProvider(),
    EdgeCloudKubeconfigProvider(),
    EdgeCloudTokenProvider(),
  );

const makeProviders = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ...websiteResources,
      ...fileStorageResources,
      ...gitResources,
      ...intakeResources,
      ...telemetryRouterResources,
      ...dremioResources,
      ...edgeCloudResources,
      ...workflowsResources,
      ...openSearchResources,
      ...logMeResources,
      ...observabilityResources,
      ...logsResources,
      ...modelServingResources,
      ...modelExperimentsResources,
      ...telemetryLinkResources,
      ...cdnResources,
      ...certificatesResources,
      ...kmsResources,
      ...serviceEnablementResources,
      ...resourceManagerResources,
      ...iamResources,
      ...iaasResources,
      ...containerApplicationsResources,
      ...containerRegistryResources,
      ...functionsResources,
      ...skeResources,
      ...dnsResources,
      ...objectStorageResources,
      ...secretsManagerResources,
      ...postgresFlexResources,
      ...sqlServerFlexResources,
      ...mariaDBResources,
      ...valkeyResources,
      ...rabbitmqResources,
      ...cloudFoundryResources,
      ...pubsubResources,
      ...mongoDBFlexResources,
      ...loadBalancerResources,
      ...albResources,
      ...wafResources,
      ...vpnResources,
      ...ipListsResources,
      ...serverBackupResources,
      ...serverUpdateResources,
      ...automationResources,
      ...unifiedFirewallResources,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        websiteProviders(),
        fileStorageProviders(),
        gitProviders(),
        intakeProviders(),
        telemetryRouterProviders(),
        dremioProviders(),
        edgeCloudProviders(),
        workflowsProviders(),
        openSearchProviders(),
        logMeProviders(),
        observabilityProviders(),
        logsProviders(),
        modelServingProviders(),
        modelExperimentsProviders(),
        telemetryLinkProviders(),
        cdnProviders(),
        certificatesProviders(),
        kmsProviders(),
        serviceEnablementProviders(),
        resourceManagerProviders(),
        iamProviders(),
        iaasProviders(),
        containerApplicationsProviders(),
        containerRegistryProviders(),
        functionsProviders(),
        skeProviders(),
        dnsProviders(),
        objectStorageProviders(),
        secretsManagerProviders(),
        postgresFlexProviders(),
        sqlServerFlexProviders(),
        mariaDBProviders(),
        valkeyProviders(),
        rabbitmqProviders(),
        cloudFoundryProviders(),
        pubsubProviders(),
        mongoDBFlexProviders(),
        loadBalancerProviders(),
        albProviders(),
        wafProviders(),
        vpnProviders(),
        ipListsProviders(),
        serverBackupProviders(),
        serverUpdateProviders(),
        automationProviders(),
        unifiedFirewallProviders(),
      ),
    ),
    // The `stackit-ske` Kubernetes cluster adapter is provideMerged (not just
    // provided) so the cluster-agnostic `Kubernetes.*` workload providers can
    // resolve it from the ambient stack context.
    Layer.provideMerge(SkeKubernetesAdapter()),
    // `Stackit.Website.StaticSite` builds with a command.
    Layer.provideMerge(Command.providers()),
    // `Stackit.Functions.Function` builds its image with Docker.
    Layer.provideMerge(DockerLive),
    Layer.provideMerge(environmentFromAuthProvider()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(StackitAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );

let cachedProviders: ReturnType<typeof makeProviders> | undefined;

/**
 * Build a layer that registers all STACKIT resource providers, the STACKIT
 * `AuthProvider`, the resolved `Credentials` and `StackitEnvironment`, and
 * an `HttpClient`. Include it from your stack alongside other clouds'
 * `providers()` layers. Memoized: every stack and test file shares one
 * layer description.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Stackit.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     yield* Stackit.ServiceEnablement.Service("Ske", {
 *       serviceId: "cloud.stackit.ske",
 *     });
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () => (cachedProviders ??= makeProviders());
